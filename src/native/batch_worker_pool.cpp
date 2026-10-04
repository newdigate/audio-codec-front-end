#include "batch_worker_pool.h"
#include <audio_codecs/wav/wav_decoder.h>
#include <audio_codecs/aiff/aiff_decoder.h>
#include <audio_codecs/mp3/mp3_decoder.h>
#include <audio_codecs/flac/flac_decoder.h>
#include <audio_codecs/vorbis/vorbis_decoder.h>
#include <audio_codecs/aac/aac_decoder.h>
#include <audio_codecs/preview/preview_generator.h>
#include <audio_codecs/preview/preview_stream.h>
#include <audio_codecs/spectrum/spectrum_generator.h>
#include <audio_codecs/spectrum/desktop_fft.h>
#include <audio_codecs/tempo/tempo_generator.h>

#include <fstream>
#include <cmath>
#include <algorithm>
#include <iostream>
#include <filesystem>
#include <cstring>

namespace audio_front_end {

namespace {

size_t SkipId3(const uint8_t* data, size_t size) {
    if (size >= 10 && data[0] == 'I' && data[1] == 'D' && data[2] == '3') {
        size_t tag_size = ((data[6] & 0x7F) << 21) |
                          ((data[7] & 0x7F) << 14) |
                          ((data[8] & 0x7F) << 7)  |
                          (data[9] & 0x7F);
        size_t total_id3_len = 10 + tag_size;
        if (data[5] & 0x10) { // footer present
            total_id3_len += 10;
        }
        return (total_id3_len < size) ? total_id3_len : size;
    }
    return 0;
}

bool DecodeWav(const uint8_t* data, size_t size, std::vector<int16_t>& outPcm, uint32_t& outSampleRate, uint8_t& outChannels) {
    auto decoder = std::make_unique<audio_codecs::wav::WavDecoder>();
    size_t consumed = 0;
    if (!decoder->parse_stream_header(data, size, consumed)) return false;
    outSampleRate = decoder->get_sample_rate();
    outChannels = decoder->get_channels();
    if (outSampleRate == 0 || outChannels == 0 || outChannels > 2) return false;

    size_t offset = consumed;
    std::vector<int16_t> chunk(4096);
    while (offset < size) {
        int samples = decoder->decode_frame_i16(data + offset, size - offset, chunk.data(), chunk.size());
        if (samples <= 0) break;
        outPcm.insert(outPcm.end(), chunk.begin(), chunk.begin() + samples);
        size_t lastFrameBytes = decoder->get_last_frame_bytes();
        if (lastFrameBytes == 0) break;
        offset += lastFrameBytes;
    }
    return !outPcm.empty();
}

bool DecodeAiff(const uint8_t* data, size_t size, std::vector<int16_t>& outPcm, uint32_t& outSampleRate, uint8_t& outChannels) {
    auto decoder = std::make_unique<audio_codecs::aiff::AiffDecoder>();
    size_t consumed = 0;
    if (!decoder->parse_stream_header(data, size, consumed)) return false;
    outSampleRate = decoder->get_sample_rate();
    outChannels = decoder->get_channels();
    if (outSampleRate == 0 || outChannels == 0 || outChannels > 2) return false;

    size_t offset = consumed;
    std::vector<int16_t> chunk(4096);
    while (offset < size) {
        int samples = decoder->decode_frame_i16(data + offset, size - offset, chunk.data(), chunk.size());
        if (samples <= 0) break;
        outPcm.insert(outPcm.end(), chunk.begin(), chunk.begin() + samples);
        size_t lastFrameBytes = decoder->get_last_frame_bytes();
        if (lastFrameBytes == 0) break;
        offset += lastFrameBytes;
    }
    return !outPcm.empty();
}

bool DecodeMp3(const uint8_t* data, size_t size, std::vector<int16_t>& outPcm, uint32_t& outSampleRate, uint8_t& outChannels) {
    auto decoder = std::make_unique<audio_codecs::mp3::Mp3Decoder>();
    audio_codecs::AudioConfig dummy_config{44100, 2, 128, false, 4};
    if (!decoder->init(dummy_config)) return false;

    size_t offset = SkipId3(data, size);
    std::vector<float> floatChunk(4608);
    uint32_t sampleRate = 0;
    uint8_t channels = 0;
    uint32_t bitrate_kbps = 0;

    while (offset + 4 <= size) {
        int samples = decoder->decode_frame(data + offset, size - offset, floatChunk.data(), floatChunk.size());
        if (samples <= 0) break;
        if (sampleRate == 0) {
            decoder->get_frame_info(sampleRate, channels, bitrate_kbps);
        }
        for (int i = 0; i < samples; ++i) {
            int32_t s = static_cast<int32_t>(floatChunk[i] * 32767.0f);
            outPcm.push_back(static_cast<int16_t>(std::clamp(s, -32768, 32767)));
        }
        size_t advance = decoder->get_last_sync_offset() + decoder->get_last_frame_bytes();
        if (advance == 0) advance = 4;
        offset += advance;
    }
    outSampleRate = (sampleRate > 0) ? sampleRate : 44100;
    outChannels = (channels > 0 && channels <= 2) ? channels : 2;
    return !outPcm.empty();
}

bool DecodeFlac(const uint8_t* data, size_t size, std::vector<int16_t>& outPcm, uint32_t& outSampleRate, uint8_t& outChannels) {
    auto decoder = std::make_unique<audio_codecs::flac::FlacDecoder>();
    size_t header_len = 0;
    if (!decoder->parse_stream_header(data, size, header_len)) return false;
    outSampleRate = decoder->get_sample_rate();
    outChannels = decoder->get_channels();
    if (outSampleRate == 0 || outChannels == 0 || outChannels > 2) return false;

    size_t offset = header_len;
    std::vector<int16_t> chunk(8192);
    while (offset + 4 <= size) {
        int samples = decoder->decode_frame_i16(data + offset, size - offset, chunk.data(), chunk.size());
        if (samples <= 0) break;
        outPcm.insert(outPcm.end(), chunk.begin(), chunk.begin() + samples);
        size_t advance = decoder->get_last_frame_bytes();
        if (advance == 0) advance = 4;
        offset += advance;
    }
    return !outPcm.empty();
}

bool DecodeOgg(const uint8_t* data, size_t size, std::vector<int16_t>& outPcm, uint32_t& outSampleRate, uint8_t& outChannels) {
    auto decoder = std::make_unique<audio_codecs::vorbis::VorbisDecoder>();
    std::vector<float> floatChunk(4096);
    uint32_t sampleRate = 0;
    uint8_t channels = 0;

    for (size_t i = 0; i < size; i += 512) {
        size_t bytes = std::min<size_t>(512, size - i);
        int samples = decoder->decode_frame(data + i, bytes, floatChunk.data(), floatChunk.size());
        if (samples > 0) {
            if (sampleRate == 0 && decoder->has_headers()) {
                sampleRate = decoder->get_info().sample_rate;
                channels = decoder->get_info().channels;
            }
            for (int s = 0; s < samples; ++s) {
                int32_t val = static_cast<int32_t>(floatChunk[s] * 32767.0f);
                outPcm.push_back(static_cast<int16_t>(std::clamp(val, -32768, 32767)));
            }
        }
    }
    outSampleRate = (sampleRate > 0) ? sampleRate : 44100;
    outChannels = (channels > 0 && channels <= 2) ? channels : 2;
    return !outPcm.empty();
}

bool DecodeAac(const uint8_t* data, size_t size, std::vector<int16_t>& outPcm, uint32_t& outSampleRate, uint8_t& outChannels) {
    auto decoder = std::make_unique<audio_codecs::aac::AacDecoder>();
    audio_codecs::AudioConfig config{44100, 2, 0, false, 0};
    if (!decoder->init(config)) return false;

    size_t offset = 0;
    std::vector<float> floatChunk(2048);
    uint32_t sampleRate = 0;
    uint8_t channels = 0;
    uint32_t bitrate_kbps = 0;

    while (offset < size) {
        int samples = decoder->decode_frame(data + offset, size - offset, floatChunk.data(), floatChunk.size());
        if (samples <= 0) break;
        if (sampleRate == 0) {
            decoder->get_frame_info(sampleRate, channels, bitrate_kbps);
        }
        for (int s = 0; s < samples; ++s) {
            int32_t val = static_cast<int32_t>(floatChunk[s] * 32767.0f);
            outPcm.push_back(static_cast<int16_t>(std::clamp(val, -32768, 32767)));
        }
        size_t frame_bytes = decoder->get_last_frame_bytes();
        if (frame_bytes == 0) break;
        offset += frame_bytes + decoder->get_last_sync_offset();
    }
    outSampleRate = (sampleRate > 0) ? sampleRate : 44100;
    outChannels = (channels > 0 && channels <= 2) ? channels : 2;
    return !outPcm.empty();
}

bool DecodeAudioFile(const std::string& filePath, std::vector<int16_t>& outPcm, uint32_t& outSampleRate, uint8_t& outChannels) {
    namespace fs = std::filesystem;
    std::ifstream file(filePath, std::ios::binary | std::ios::ate);
    if (!file.is_open()) return false;
    std::streamsize fileSize = file.tellg();
    if (fileSize <= 0) return false;
    file.seekg(0, std::ios::beg);

    std::vector<uint8_t> buffer(fileSize);
    if (!file.read(reinterpret_cast<char*>(buffer.data()), fileSize)) return false;

    std::string ext = fs::path(filePath).extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

    if (ext == ".wav" || ext == ".wave") {
        return DecodeWav(buffer.data(), buffer.size(), outPcm, outSampleRate, outChannels);
    } else if (ext == ".aiff" || ext == ".aif") {
        return DecodeAiff(buffer.data(), buffer.size(), outPcm, outSampleRate, outChannels);
    } else if (ext == ".mp3") {
        return DecodeMp3(buffer.data(), buffer.size(), outPcm, outSampleRate, outChannels);
    } else if (ext == ".flac") {
        return DecodeFlac(buffer.data(), buffer.size(), outPcm, outSampleRate, outChannels);
    } else if (ext == ".ogg" || ext == ".oga") {
        return DecodeOgg(buffer.data(), buffer.size(), outPcm, outSampleRate, outChannels);
    } else if (ext == ".aac" || ext == ".m4a") {
        return DecodeAac(buffer.data(), buffer.size(), outPcm, outSampleRate, outChannels);
    }
    return false;
}

} // anonymous namespace

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
        CachedAnalysisData cachedData;
        if (cache_.ReadCache(filePath, cachedData, flatSidecar)) {
            NotifyProgress(ProgressUpdate{
                filePath,
                100.0,
                cachedData.bpm,
                "cached",
                cachedData.durationMs
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

    // 3. Decode audio file
    std::vector<int16_t> pcmSamples;
    uint32_t sampleRate = 0;
    uint8_t channels = 0;
    if (!DecodeAudioFile(filePath, pcmSamples, sampleRate, channels) || pcmSamples.empty() || channels == 0) {
        NotifyProgress(ProgressUpdate{
            filePath,
            0.0,
            0.0,
            "error",
            0
        });
        return;
    }
    std::cout << "[pool] Decoded " << pcmSamples.size() << " samples, rate=" << sampleRate << ", ch=" << static_cast<int>(channels) << std::endl;

    if (stop_) return;

    uint64_t totalFrames = pcmSamples.size() / channels;
    uint32_t durationMs = (sampleRate > 0) ? static_cast<uint32_t>((totalFrames * 1000ULL) / sampleRate) : 0;

    // 4. Generate Audio Preview (.apv)
    audio_codecs::preview::MemoryReader pcmReader(
        reinterpret_cast<const uint8_t*>(pcmSamples.data()),
        pcmSamples.size() * sizeof(int16_t)
    );

    size_t apvCapacity = std::max<size_t>(65536, 1024 + (totalFrames / 128 + 64) * 4 * 2);
    std::vector<uint8_t> apvStorage(apvCapacity, 0);
    audio_codecs::preview::MemoryWriter apvWriter(apvStorage.data(), apvStorage.size());

    auto previewGen = std::make_unique<audio_codecs::preview::PreviewGenerator>();
    bool initPreview = previewGen->init(pcmReader, apvWriter, nullptr, sampleRate, channels, channels > 1);
    if (!initPreview || !previewGen->generate_all()) {
        NotifyProgress(ProgressUpdate{ filePath, 0.0, 0.0, "error", 0 });
        return;
    }

    if (stop_) return;

    audio_codecs::preview::ApvHeader apvHeader = previewGen->header();
    std::vector<std::vector<int8_t>> lodData(apvHeader.lod_count);
    for (size_t i = 0; i < apvHeader.lod_count; ++i) {
        uint64_t offset = apvHeader.lods[i].file_offset;
        size_t bytes = static_cast<size_t>(apvHeader.lods[i].chunk_count) * apvHeader.bytes_per_chunk;
        if (offset + bytes <= apvWriter.size()) {
            lodData[i].resize(bytes);
            std::memcpy(lodData[i].data(), apvStorage.data() + offset, bytes);
        }
    }

    // 5. Generate Spectrum (.asv) and Tempo (.att)
    size_t asvCapacity = std::max<size_t>(65536, 1024 + (totalFrames / 512 + 64) * 64 * 2);
    std::vector<uint8_t> asvStorage(asvCapacity, 0);
    audio_codecs::preview::MemoryWriter asvWriter(asvStorage.data(), asvStorage.size());

    auto spectrumGen = std::make_unique<audio_codecs::spectrum::SpectrumGenerator>();
    auto fftBackend = std::make_unique<audio_codecs::spectrum::DesktopRealFftBackend>();
    fftBackend->init();

    pcmReader.seek(0);
    bool initAsv = spectrumGen->init(pcmReader, asvWriter, *fftBackend, sampleRate, channels, true, 64);
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
