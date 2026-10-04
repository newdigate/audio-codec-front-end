#include "batch_worker_pool.h"
#include "chunk_decoder.h"
#include <audio_codecs/preview/preview_generator.h>
#include <audio_codecs/spectrum/spectrum_generator.h>
#include <audio_codecs/spectrum/desktop_fft.h>
#include <audio_codecs/tempo/tempo_generator.h>

#include <cmath>
#include <algorithm>
#include <filesystem>
#include <cstring>

namespace audio_front_end {

BatchWorkerPool::BatchWorkerPool() = default;

BatchWorkerPool::~BatchWorkerPool() {
    Cancel();
}

void BatchWorkerPool::StartBatch(const std::vector<std::string>& files, bool flatSidecar, Napi::ThreadSafeFunction tsfn) {
    Cancel();

    progressCallback_ = tsfn;
    stop_ = false;
    paused_ = false;

    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        while (!queue_.empty()) queue_.pop();
        for (const auto& file : files) {
            queue_.push(BatchJob{file, flatSidecar});
        }
    }

    remainingJobs_ = files.size();
    if (files.empty()) {
        progressCallback_.Release();
        return;
    }

    unsigned int hw = std::thread::hardware_concurrency();
    if (hw == 0) hw = 4;
    size_t numThreads = std::min<size_t>(hw, files.size());
    if (numThreads == 0) numThreads = 1;

    workers_.reserve(numThreads);
    for (size_t i = 0; i < numThreads; ++i) {
        workers_.emplace_back(&BatchWorkerPool::WorkerLoop, this);
    }
}

void BatchWorkerPool::Pause() {
    paused_ = true;
}

void BatchWorkerPool::Resume() {
    paused_ = false;
    cv_.notify_all();
}

void BatchWorkerPool::Cancel() {
    stop_ = true;
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        while (!queue_.empty()) queue_.pop();
    }
    cv_.notify_all();
    JoinWorkers();
}

bool BatchWorkerPool::IsRunning() const {
    return !stop_ && remainingJobs_ > 0;
}

void BatchWorkerPool::JoinWorkers() {
    for (auto& w : workers_) {
        if (w.joinable()) {
            w.join();
        }
    }
    workers_.clear();
}

void BatchWorkerPool::NotifyProgress(const ProgressUpdate& update) {
    if (stop_) return;
    auto copy = std::make_shared<ProgressUpdate>(update);
    progressCallback_.BlockingCall([copy](Napi::Env env, Napi::Function jsCallback) {
        if (env == nullptr || jsCallback == nullptr) return;
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("filePath", Napi::String::New(env, copy->filePath));
        obj.Set("progressPct", Napi::Number::New(env, copy->progressPct));
        obj.Set("bpm", Napi::Number::New(env, copy->bpm));
        obj.Set("status", Napi::String::New(env, copy->status));
        obj.Set("durationMs", Napi::Number::New(env, copy->durationMs));
        jsCallback.Call({ obj });
    });
}

void BatchWorkerPool::WorkerLoop() {
    while (!stop_) {
        BatchJob job;
        {
            std::unique_lock<std::mutex> lock(queueMutex_);
            cv_.wait(lock, [this]() {
                return stop_ || (!paused_ && !queue_.empty());
            });

            if (stop_ || queue_.empty()) {
                break;
            }

            job = queue_.front();
            queue_.pop();
        }

        ProcessFile(job.filePath, job.flatSidecar);

        size_t rem = --remainingJobs_;
        if (rem == 0) {
            stop_ = true;
            cv_.notify_all();
            break;
        }
    }

    progressCallback_.Release();
}

void BatchWorkerPool::ProcessFile(const std::string& filePath, bool flatSidecar) {
    if (stop_) return;

    // 1. If already cached, notify immediately and skip reprocessing
    if (cache_.HasValidCache(filePath, flatSidecar)) {
        uint32_t durationMs = 0;
        double bpm = 0.0;
        if (cache_.ReadCacheHeader(filePath, durationMs, bpm, flatSidecar)) {
            NotifyProgress(ProgressUpdate{
                filePath,
                100.0,
                bpm,
                "cached",
                durationMs
            });
            return;
        }
    }

    // 2. Notify processing started
    NotifyProgress(ProgressUpdate{
        filePath,
        0.0,
        0.0,
        "processing",
        0
    });

    if (stop_) return;

    // 3. Open streaming decoder
    ChunkAudioDecoder decoder;
    if (!decoder.Open(filePath)) {
        NotifyProgress(ProgressUpdate{
            filePath,
            0.0,
            0.0,
            "error",
            0
        });
        return;
    }

    uint32_t sampleRate = decoder.GetSampleRate();
    uint8_t channels = decoder.GetChannels();
    if (sampleRate == 0 || channels == 0 || channels > 2) {
        NotifyProgress(ProgressUpdate{
            filePath,
            0.0,
            0.0,
            "error",
            0
        });
        return;
    }

    if (stop_) return;

    // 4. Stream-decode incrementally into PreviewGenerator
    StreamingAudioPcmReader streamingReader(decoder);

    uint64_t estFrames = decoder.GetTotalFrames();
    if (estFrames == 0) {
        std::error_code fsec;
        auto fsize = std::filesystem::file_size(filePath, fsec);
        if (!fsec && fsize > 0) {
            estFrames = std::max<uint64_t>(44100ULL * 600, (static_cast<uint64_t>(fsize) / 4) * 8);
        } else {
            estFrames = 44100ULL * 600; // 10 minutes default
        }
    }
    size_t apvCapacity = std::max<size_t>(1048576, 1024 + (estFrames / 128 + 64) * 4 * 2);
    std::vector<uint8_t> apvStorage(apvCapacity, 0);
    audio_codecs::preview::MemoryWriter apvWriter(apvStorage.data(), apvStorage.size());

    auto previewGen = std::make_unique<audio_codecs::preview::PreviewGenerator>();
    bool initPreview = previewGen->init(streamingReader, apvWriter, nullptr, sampleRate, channels, channels > 1);
    if (!initPreview || !previewGen->generate_all()) {
        NotifyProgress(ProgressUpdate{ filePath, 0.0, 0.0, "error", 0 });
        return;
    }

    if (stop_) return;

    audio_codecs::preview::ApvHeader apvHeader = previewGen->header();
    uint64_t totalFrames = apvHeader.total_pcm_frames;
    uint32_t durationMs = apvHeader.duration_ms;

    std::vector<std::vector<int8_t>> lodData(apvHeader.lod_count);
    for (size_t i = 0; i < apvHeader.lod_count; ++i) {
        uint64_t offset = apvHeader.lods[i].file_offset;
        size_t bytes = static_cast<size_t>(apvHeader.lods[i].chunk_count) * apvHeader.bytes_per_chunk;
        if (offset + bytes <= apvWriter.size()) {
            lodData[i].resize(bytes);
            std::memcpy(lodData[i].data(), apvStorage.data() + offset, bytes);
        }
    }

    // 5. Stream-decode incrementally into Spectrum (.asv) and Tempo (.att)
    streamingReader.seek(0);

    size_t asvCapacity = std::max<size_t>(65536, 1024 + (totalFrames / 512 + 64) * 64 * 2);
    std::vector<uint8_t> asvStorage(asvCapacity, 0);
    audio_codecs::preview::MemoryWriter asvWriter(asvStorage.data(), asvStorage.size());

    auto spectrumGen = std::make_unique<audio_codecs::spectrum::SpectrumGenerator>();
    auto fftBackend = std::make_unique<audio_codecs::spectrum::DesktopRealFftBackend>();
    fftBackend->init();

    bool initAsv = spectrumGen->init(streamingReader, asvWriter, *fftBackend, sampleRate, channels, true, 64);
    if (initAsv) {
        spectrumGen->generate_all();
    }

    if (stop_) return;

    audio_codecs::preview::MemoryReader asvReader(asvStorage.data(), asvWriter.size());
    size_t attCapacity = std::max<size_t>(65536, 1024 + (totalFrames / 22050 + 64) * 64);
    std::vector<uint8_t> attStorage(attCapacity, 0);
    audio_codecs::preview::MemoryWriter attWriter(attStorage.data(), attStorage.size());

    auto tempoGen = std::make_unique<audio_codecs::tempo::TempoGenerator>();
    audio_codecs::tempo::AttHeader attHeader{};
    std::vector<audio_codecs::tempo::AttBeatMarker> beatMarkers;

    bool initTempo = tempoGen->init(&asvReader, &attWriter);
    if (initTempo) {
        while (tempoGen->step(128)) {
            if (stop_) return;
        }
        attHeader = tempoGen->header();
        if (attHeader.beat_grid_count > 0 &&
            attHeader.beat_grid_offset + attHeader.beat_grid_count * sizeof(audio_codecs::tempo::AttBeatMarker) <= attWriter.size()) {
            beatMarkers.resize(attHeader.beat_grid_count);
            std::memcpy(beatMarkers.data(),
                        attStorage.data() + attHeader.beat_grid_offset,
                        beatMarkers.size() * sizeof(audio_codecs::tempo::AttBeatMarker));
        }
    }

    if (attHeader.global_bpm_q16 == 0) {
        attHeader.global_bpm_q16 = 120 << 16;
        attHeader.sample_rate = sampleRate;
        attHeader.duration_ms = durationMs;
        attHeader.time_signature_num = 4;
        attHeader.time_signature_denom = 4;
        attHeader.confidence = 50;
    }

    if (stop_) return;

    // Ensure source_file_size matches audio file size on disk
    namespace fs = std::filesystem;
    std::error_code ec;
    if (fs::exists(filePath, ec)) {
        apvHeader.source_file_size = static_cast<uint32_t>(fs::file_size(filePath, ec));
    }

    // 6. Write cache
    if (!cache_.WriteCache(filePath, apvHeader, lodData, attHeader, beatMarkers, flatSidecar)) {
        NotifyProgress(ProgressUpdate{ filePath, 0.0, 0.0, "error", 0 });
        return;
    }

    // 7. Notify complete
    double bpm = static_cast<double>(attHeader.global_bpm_q16) / 65536.0;
    NotifyProgress(ProgressUpdate{
        filePath,
        100.0,
        bpm,
        "cached",
        durationMs
    });
}

} // namespace audio_front_end
