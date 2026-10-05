#include "playback_engine.h"
#include <cmath>
#include <algorithm>
#include <filesystem>
#include <cstring>

namespace audio_front_end {

AudioPlaybackEngine::AudioPlaybackEngine() {
    if (EnsureSoundIo()) {
        OpenStream(44100);
    }
    decoderThread_ = std::thread(&AudioPlaybackEngine::DecoderThreadLoop, this);
}

AudioPlaybackEngine::~AudioPlaybackEngine() {
    Stop();
    StopDecoder();
    CleanupSoundIo();
}

bool AudioPlaybackEngine::EnsureSoundIo() {
    if (soundio_ && device_) return true;
    if (!soundio_) {
        soundio_ = soundio_create();
        if (!soundio_) return false;
        int err = soundio_connect(soundio_);
        if (err) {
            soundio_destroy(soundio_);
            soundio_ = nullptr;
            return false;
        }
        soundio_flush_events(soundio_);
    }
    if (!device_) {
        int default_out_idx = soundio_default_output_device_index(soundio_);
        if (default_out_idx < 0) return false;
        device_ = soundio_get_output_device(soundio_, default_out_idx);
        if (!device_) return false;
    }
    return true;
}

void AudioPlaybackEngine::CleanupSoundIo() {
    CloseStream();
    if (device_) {
        soundio_device_unref(device_);
        device_ = nullptr;
    }
    if (soundio_) {
        soundio_destroy(soundio_);
        soundio_ = nullptr;
    }
}

bool AudioPlaybackEngine::OpenStream(int sampleRate) {
    std::lock_guard<std::mutex> streamLock(streamMutex_);
    if (outstream_) {
        if (outstream_->sample_rate == sampleRate) {
            return true;
        }
        soundio_outstream_pause(outstream_, true);
        soundio_outstream_destroy(outstream_);
        outstream_ = nullptr;
        isActivelyStreaming_.store(false, std::memory_order_release);
    }
    if (!EnsureSoundIo()) return false;

    outstream_ = soundio_outstream_create(device_);
    if (!outstream_) return false;

    outstream_->format = SoundIoFormatFloat32NE;
    outstream_->sample_rate = sampleRate;
    outstream_->layout = *soundio_channel_layout_get_default(2);
    double targetLatency = 0.10; // ~100ms latency cushion for rock-solid playback
    if (device_->software_latency_max > 0.0) {
        targetLatency = std::min(targetLatency, device_->software_latency_max);
    }
    if (device_->software_latency_min > 0.0) {
        targetLatency = std::max(targetLatency, device_->software_latency_min);
    }
    outstream_->software_latency = targetLatency;
    outstream_->userdata = this;
    outstream_->write_callback = &AudioPlaybackEngine::OnWriteCallback;
    outstream_->underflow_callback = &AudioPlaybackEngine::OnUnderflowCallback;
    outstream_->error_callback = &AudioPlaybackEngine::OnErrorCallback;

    int err = soundio_outstream_open(outstream_);
    if (err) {
        soundio_outstream_destroy(outstream_);
        outstream_ = nullptr;
        return false;
    }

    err = soundio_outstream_start(outstream_);
    if (err) {
        soundio_outstream_destroy(outstream_);
        outstream_ = nullptr;
        return false;
    }

    soundio_outstream_pause(outstream_, true);
    isActivelyStreaming_.store(false, std::memory_order_release);
    return true;
}

void AudioPlaybackEngine::CloseStream() {
    std::lock_guard<std::mutex> streamLock(streamMutex_);
    if (outstream_) {
        soundio_outstream_pause(outstream_, true);
        soundio_outstream_destroy(outstream_);
        outstream_ = nullptr;
    }
    isActivelyStreaming_.store(false, std::memory_order_release);
}

void AudioPlaybackEngine::OnWriteCallback(SoundIoOutStream* stream, int frame_count_min, int frame_count_max) {
    auto* self = static_cast<AudioPlaybackEngine*>(stream->userdata);
    if (self) {
        self->HandleAudioWrite(stream, frame_count_min, frame_count_max);
    }
}

void AudioPlaybackEngine::OnUnderflowCallback(SoundIoOutStream* stream) {
    auto* self = static_cast<AudioPlaybackEngine*>(stream->userdata);
    if (self) {
        self->underflowCount_.fetch_add(1, std::memory_order_relaxed);
    }
}

void AudioPlaybackEngine::OnErrorCallback(SoundIoOutStream* /*stream*/, int /*err*/) {
}

void AudioPlaybackEngine::WriteSilence(SoundIoOutStream* stream, int frame_count_max) {
    SoundIoChannelArea* areas = nullptr;
    int frames_left = frame_count_max;
    while (frames_left > 0) {
        int frame_count = frames_left;
        int err = soundio_outstream_begin_write(stream, &areas, &frame_count);
        if (err || frame_count <= 0) break;
        for (int f = 0; f < frame_count; ++f) {
            for (int ch = 0; ch < stream->layout.channel_count; ++ch) {
                float* ptr = reinterpret_cast<float*>(areas[ch].ptr + areas[ch].step * f);
                *ptr = 0.0f;
            }
        }
        soundio_outstream_end_write(stream);
        frames_left -= frame_count;
    }
}

void AudioPlaybackEngine::HandleAudioWrite(SoundIoOutStream* stream, int /*frame_count_min*/, int frame_count_max) {
    // 1. Check if flush is requested by producer
    if (flushRequested_.load(std::memory_order_acquire)) {
        ringBuffer_.discardAll();
        flushRequested_.store(false, std::memory_order_release);
        flushAck_.store(true, std::memory_order_release);
        WriteSilence(stream, frame_count_max);
        return;
    }

    bool playing = isPlaying_.load(std::memory_order_relaxed);
    bool paused = isPaused_.load(std::memory_order_relaxed);

    if (!playing || paused) {
        WriteSilence(stream, frame_count_max);
        return;
    }

    SoundIoChannelArea* areas = nullptr;
    int frames_left = frame_count_max;
    float vol = volume_.load(std::memory_order_relaxed);

    // Pull from lock-free ring buffer
    while (frames_left > 0) {
        int frame_count = frames_left;
        int err = soundio_outstream_begin_write(stream, &areas, &frame_count);
        if (err || frame_count <= 0) break;

        size_t availSamples = ringBuffer_.availableRead();
        size_t availFrames = availSamples / 2;
        size_t framesFromRing = std::min<size_t>(frame_count, availFrames);

        int64_t total = totalFrames_.load(std::memory_order_relaxed);
        int64_t cur = currentFrame_.load(std::memory_order_relaxed);
        bool isEof = (total > 0 && cur + static_cast<int64_t>(framesFromRing) >= total);

        if (!isEof && framesFromRing < static_cast<size_t>(frame_count)) {
            underflowCount_.fetch_add(1, std::memory_order_relaxed);
            silenceFramesWritten_.fetch_add(frame_count - framesFromRing, std::memory_order_relaxed);
        }

        size_t framesProcessed = 0;
        int numChannels = stream->layout.channel_count;
        char* leftBase = areas[0].ptr;
        int leftStep = areas[0].step;
        char* rightBase = (numChannels > 1) ? areas[1].ptr : nullptr;
        int rightStep = (numChannels > 1) ? areas[1].step : 0;

        while (framesProcessed < framesFromRing) {
            size_t chunk = std::min<size_t>(framesFromRing - framesProcessed, 1024);
            float stackBuf[2048]; // 1024 stereo frames on stack (zero heap allocation)
            ringBuffer_.read(stackBuf, chunk * 2);

            for (size_t f = 0; f < chunk; ++f) {
                size_t outFrameIdx = framesProcessed + f;
                float left = stackBuf[f * 2] * vol;
                float right = stackBuf[f * 2 + 1] * vol;
                *reinterpret_cast<float*>(leftBase + leftStep * outFrameIdx) = left;
                if (rightBase) {
                    *reinterpret_cast<float*>(rightBase + rightStep * outFrameIdx) = right;
                }
                for (int ch = 2; ch < numChannels; ++ch) {
                    *reinterpret_cast<float*>(areas[ch].ptr + areas[ch].step * outFrameIdx) = 0.0f;
                }
            }
            framesProcessed += chunk;
        }

        // Fill remaining requested frames with silence
        for (size_t f = framesFromRing; f < static_cast<size_t>(frame_count); ++f) {
            *reinterpret_cast<float*>(leftBase + leftStep * f) = 0.0f;
            if (rightBase) {
                *reinterpret_cast<float*>(rightBase + rightStep * f) = 0.0f;
            }
            for (int ch = 2; ch < numChannels; ++ch) {
                *reinterpret_cast<float*>(areas[ch].ptr + areas[ch].step * f) = 0.0f;
            }
        }

        soundio_outstream_end_write(stream);

        currentFrame_.fetch_add(framesFromRing, std::memory_order_relaxed);
        if (total > 0 && currentFrame_.load(std::memory_order_relaxed) >= total) {
            isPlaying_.store(false, std::memory_order_release);
        }

        frames_left -= frame_count;
        if (framesFromRing == 0) {
            break;
        }
    }

    if (frames_left > 0) {
        WriteSilence(stream, frames_left);
    }
}

void AudioPlaybackEngine::StopDecoder() {
    stopDecoder_.store(true, std::memory_order_release);
    decoderCv_.notify_all();
    if (decoderThread_.joinable()) {
        decoderThread_.join();
    }
}

void AudioPlaybackEngine::ExecuteSeek(int64_t targetFrame) {
    int64_t total = totalFrames_.load(std::memory_order_relaxed);
    if (total > 0) {
        targetFrame = std::clamp<int64_t>(targetFrame, 0, total);
    } else if (targetFrame < 0) {
        targetFrame = 0;
    }

    // Flush existing ring buffer contents safely
    if (isActivelyStreaming_.load(std::memory_order_relaxed)) {
        flushAck_.store(false, std::memory_order_release);
        flushRequested_.store(true, std::memory_order_release);
        // Wait for audio callback to acknowledge discard (up to 200ms for ~100ms hardware latency)
        int waitCount = 0;
        while (!flushAck_.load(std::memory_order_acquire) && waitCount < 400) {
            std::this_thread::sleep_for(std::chrono::microseconds(500));
            waitCount++;
        }
        flushRequested_.store(false, std::memory_order_release);
    } else {
        ringBuffer_.clear();
    }

    streamDecoder_.SeekFrame(targetFrame);
    currentDecodedFrame_ = targetFrame;
    currentFrame_.store(targetFrame, std::memory_order_release);

    // Pre-fill ring buffer aggressively: decode up to 65536 frames
    // or until EOF so CoreAudio never encounters an initial underrun on playback start or seek.
    while (ringBuffer_.availableWrite() >= 4096) {
        size_t availWrite = ringBuffer_.availableWrite();
        size_t framesToFill = std::min<size_t>(availWrite / 2, 8192);
        float stackBuf[16384];
        size_t decoded = streamDecoder_.DecodeChunkF32Stereo(stackBuf, framesToFill);
        if (decoded == 0) {
            if (streamDecoder_.IsEof()) {
                totalFrames_.store(currentDecodedFrame_, std::memory_order_release);
            }
            break;
        }
        ringBuffer_.write(stackBuf, decoded * 2);
        currentDecodedFrame_ += static_cast<int64_t>(decoded);
        if (ringBuffer_.availableRead() / 2 >= 65536) {
            break;
        }
    }
}

void AudioPlaybackEngine::DecoderThreadLoop() {
    while (!stopDecoder_.load(std::memory_order_relaxed)) {
        // 1. Drain FIFO command queue
        while (true) {
            DecoderCommand cmd;
            {
                std::lock_guard<std::mutex> lock(commandMutex_);
                if (commandQueue_.empty()) break;
                cmd = commandQueue_.front();
                commandQueue_.pop();

                // Coalesce rapid consecutive seek commands or immediate seek after LoadAndPlay
                if (cmd.type == DecoderCommandType::LoadAndPlay) {
                    if (!commandQueue_.empty() && commandQueue_.front().type == DecoderCommandType::Seek) {
                        cmd.offsetMs = commandQueue_.front().offsetMs;
                        commandQueue_.pop();
                    }
                } else if (cmd.type == DecoderCommandType::Seek) {
                    while (!commandQueue_.empty() && commandQueue_.front().type == DecoderCommandType::Seek) {
                        cmd = commandQueue_.front();
                        commandQueue_.pop();
                    }
                }
            }

            if (cmd.type == DecoderCommandType::LoadAndPlay) {
                if (!cmd.filePath.empty() && (cmd.filePath != currentFilePath_ || !streamDecoder_.IsOpen())) {
                    bool ok = LoadTrack(cmd.filePath);
                    if (!ok) {
                        isPlaying_.store(false, std::memory_order_release);
                        continue;
                    }
                    OpenStream(sampleRate_.load(std::memory_order_relaxed));
                }
                uint32_t rate = sampleRate_.load(std::memory_order_relaxed);
                if (rate == 0) rate = 44100;
                int64_t targetFrame = static_cast<int64_t>((cmd.offsetMs * static_cast<double>(rate)) / 1000.0);
                ExecuteSeek(targetFrame);

                isPlaying_.store(true, std::memory_order_release);
                isPaused_.store(false, std::memory_order_release);
                std::lock_guard<std::mutex> streamLock(streamMutex_);
                if (outstream_) {
                    soundio_outstream_pause(outstream_, false);
                    isActivelyStreaming_.store(true, std::memory_order_release);
                }
            } else if (cmd.type == DecoderCommandType::Pause) {
                isPaused_.store(true, std::memory_order_release);
                std::lock_guard<std::mutex> streamLock(streamMutex_);
                if (outstream_) {
                    soundio_outstream_pause(outstream_, true);
                }
                isActivelyStreaming_.store(false, std::memory_order_release);
            } else if (cmd.type == DecoderCommandType::Resume) {
                isPaused_.store(false, std::memory_order_release);
                isPlaying_.store(true, std::memory_order_release);
                std::lock_guard<std::mutex> streamLock(streamMutex_);
                if (outstream_) {
                    soundio_outstream_pause(outstream_, false);
                    isActivelyStreaming_.store(true, std::memory_order_release);
                }
            } else if (cmd.type == DecoderCommandType::Stop) {
                isPlaying_.store(false, std::memory_order_release);
                isPaused_.store(false, std::memory_order_release);
                currentFrame_.store(0, std::memory_order_release);
                currentDecodedFrame_ = 0;
                streamDecoder_.SeekFrame(0);
                ringBuffer_.clear();
                std::lock_guard<std::mutex> streamLock(streamMutex_);
                if (outstream_) {
                    soundio_outstream_pause(outstream_, true);
                }
                isActivelyStreaming_.store(false, std::memory_order_release);
            } else if (cmd.type == DecoderCommandType::Seek) {
                uint32_t rate = sampleRate_.load(std::memory_order_relaxed);
                if (rate == 0) rate = 44100;
                int64_t targetFrame = static_cast<int64_t>((cmd.offsetMs * static_cast<double>(rate)) / 1000.0);
                ExecuteSeek(targetFrame);
            }
        }

        bool playing = isPlaying_.load(std::memory_order_acquire);
        bool paused = isPaused_.load(std::memory_order_acquire);

        // Streaming PCM floats on-demand into ring buffer ahead of playhead:
        // Continually decode and top up the ring buffer while free space exists (maintain ~3 sec buffer cushion).
        while (playing && !paused && !stopDecoder_.load(std::memory_order_relaxed)) {
            size_t availWrite = ringBuffer_.availableWrite();
            // If ring buffer has less than 4096 samples free (<2048 frames headroom), it is effectively full
            if (availWrite < 4096) {
                break;
            }
            size_t framesToDecode = std::min<size_t>(availWrite / 2, 8192);
            float stackBuf[16384];
            size_t decoded = streamDecoder_.DecodeChunkF32Stereo(stackBuf, framesToDecode);
            if (decoded > 0) {
                ringBuffer_.write(stackBuf, decoded * 2);
                currentDecodedFrame_ += static_cast<int64_t>(decoded);
            } else {
                if (streamDecoder_.IsEof()) {
                    totalFrames_.store(currentDecodedFrame_, std::memory_order_release);
                }
                break;
            }
        }

        std::unique_lock<std::mutex> lock(commandMutex_);
        decoderCv_.wait_for(lock, std::chrono::milliseconds(10), [&] {
            return stopDecoder_.load(std::memory_order_relaxed) ||
                   !commandQueue_.empty() ||
                   (isPlaying_.load(std::memory_order_relaxed) &&
                    !isPaused_.load(std::memory_order_relaxed) &&
                    ringBuffer_.availableWrite() >= 8192);
        });
    }
}

bool AudioPlaybackEngine::LoadTrack(const std::string& filePath) {
    if (!streamDecoder_.Open(filePath)) return false;
    currentFilePath_ = filePath;
    uint32_t rate = streamDecoder_.GetSampleRate();
    if (rate == 0) rate = 44100;
    sampleRate_.store(rate, std::memory_order_release);
    totalFrames_.store(static_cast<int64_t>(streamDecoder_.GetTotalFrames()), std::memory_order_release);
    currentDecodedFrame_ = 0;
    return true;
}

bool AudioPlaybackEngine::Play(const std::string& filePath, double startOffsetMs) {
    if (filePath.empty()) {
        return Resume();
    }

    namespace fs = std::filesystem;
    std::error_code ec;
    if (!fs::exists(filePath, ec) || !fs::is_regular_file(filePath, ec)) {
        return false;
    }

    uint32_t rate = sampleRate_.load(std::memory_order_relaxed);
    if (rate == 0) rate = 44100;
    int64_t targetFrame = static_cast<int64_t>((startOffsetMs * static_cast<double>(rate)) / 1000.0);
    currentFrame_.store(targetFrame, std::memory_order_release);

    {
        std::lock_guard<std::mutex> lock(commandMutex_);
        commandQueue_.push({DecoderCommandType::LoadAndPlay, filePath, startOffsetMs});
    }
    decoderCv_.notify_one();
    return true;
}

bool AudioPlaybackEngine::Pause() {
    if (!isPlaying_.load(std::memory_order_relaxed)) {
        return false;
    }
    if (isPaused_.load(std::memory_order_relaxed)) {
        return Resume();
    }
    isPaused_.store(true, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(commandMutex_);
        commandQueue_.push({DecoderCommandType::Pause, "", 0.0});
    }
    decoderCv_.notify_one();
    return true;
}

bool AudioPlaybackEngine::Resume() {
    if (isPaused_.load(std::memory_order_relaxed)) {
        isPaused_.store(false, std::memory_order_release);
        isPlaying_.store(true, std::memory_order_release);
        {
            std::lock_guard<std::mutex> lock(commandMutex_);
            commandQueue_.push({DecoderCommandType::Resume, "", 0.0});
        }
        decoderCv_.notify_one();
        return true;
    }
    if (!isPlaying_.load(std::memory_order_relaxed)) {
        uint32_t rate = sampleRate_.load(std::memory_order_relaxed);
        if (rate == 0) rate = 44100;
        int64_t cur = currentFrame_.load(std::memory_order_relaxed);
        double ms = (static_cast<double>(cur) * 1000.0) / static_cast<double>(rate);
        return Play(currentFilePath_, ms);
    }
    return true;
}

bool AudioPlaybackEngine::Stop() {
    isPlaying_.store(false, std::memory_order_release);
    isPaused_.store(false, std::memory_order_release);
    currentFrame_.store(0, std::memory_order_release);
    {
        std::lock_guard<std::mutex> lock(commandMutex_);
        commandQueue_.push({DecoderCommandType::Stop, "", 0.0});
    }
    decoderCv_.notify_one();
    return true;
}

bool AudioPlaybackEngine::Seek(double offsetMs) {
    uint32_t rate = sampleRate_.load(std::memory_order_relaxed);
    if (rate == 0) rate = 44100;
    int64_t targetFrame = static_cast<int64_t>((offsetMs * static_cast<double>(rate)) / 1000.0);
    int64_t total = totalFrames_.load(std::memory_order_relaxed);
    if (total > 0) {
        targetFrame = std::clamp<int64_t>(targetFrame, 0, total);
    } else if (targetFrame < 0) {
        targetFrame = 0;
    }

    currentFrame_.store(targetFrame, std::memory_order_release);

    {
        std::lock_guard<std::mutex> lock(commandMutex_);
        commandQueue_.push({DecoderCommandType::Seek, "", offsetMs});
    }
    decoderCv_.notify_one();
    return true;
}

void AudioPlaybackEngine::SetVolume(double volume) {
    float vol = static_cast<float>(std::clamp(volume, 0.0, 1.0));
    volume_.store(vol, std::memory_order_relaxed);
}

PlaybackPosition AudioPlaybackEngine::GetPosition() const {
    PlaybackPosition pos;
    pos.isPlaying = isPlaying_.load(std::memory_order_acquire) && !isPaused_.load(std::memory_order_acquire);
    uint32_t rate = sampleRate_.load(std::memory_order_relaxed);
    if (rate == 0) rate = 44100;
    int64_t frame = currentFrame_.load(std::memory_order_relaxed);
    int64_t total = totalFrames_.load(std::memory_order_relaxed);
    if (total > 0 && frame > total) frame = total;
    if (frame < 0) frame = 0;
    pos.currentMs = (static_cast<double>(frame) * 1000.0) / static_cast<double>(rate);
    pos.underflowCount = underflowCount_.load(std::memory_order_relaxed);
    pos.bufferedFrames = ringBuffer_.availableRead() / 2;
    return pos;
}

} // namespace audio_front_end
