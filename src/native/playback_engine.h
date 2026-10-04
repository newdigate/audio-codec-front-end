#pragma once

#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <soundio/soundio.h>
#include "ring_buffer.h"

namespace audio_front_end {

struct PlaybackPosition {
    bool isPlaying{false};
    double currentMs{0.0};
};

class AudioPlaybackEngine {
public:
    AudioPlaybackEngine();
    ~AudioPlaybackEngine();

    // Core playback controls
    bool Play(const std::string& filePath, double startOffsetMs);
    bool Pause();
    bool Resume();
    bool Stop();
    bool Seek(double offsetMs);
    PlaybackPosition GetPosition() const;
    void SetVolume(double volume);

private:
    bool EnsureSoundIo();
    void CleanupSoundIo();
    bool OpenStream(int sampleRate);
    void CloseStream();

    static void OnWriteCallback(struct SoundIoOutStream* stream, int frame_count_min, int frame_count_max);
    static void OnUnderflowCallback(struct SoundIoOutStream* stream);
    static void OnErrorCallback(struct SoundIoOutStream* stream, int err);

    void HandleAudioWrite(struct SoundIoOutStream* stream, int frame_count_min, int frame_count_max);

    void DecoderThreadLoop();
    void StopDecoder();

    bool LoadAndDecodeTrack(const std::string& filePath);

    // libsoundio objects
    SoundIo* soundio_{nullptr};
    SoundIoDevice* device_{nullptr};
    SoundIoOutStream* outstream_{nullptr};

    // Atomic playback state
    std::atomic<bool> isPlaying_{false};
    std::atomic<bool> isPaused_{false};
    std::atomic<int64_t> currentFrame_{0};
    std::atomic<int64_t> totalFrames_{0};
    std::atomic<uint32_t> sampleRate_{44100};
    std::atomic<float> volume_{1.0f};

    // Lock-free ring buffer (stereo floats)
    // 262144 floats = 131072 stereo frames (~2.97s at 44.1kHz)
    SpscRingBuffer<float> ringBuffer_{262144};

    // Decoder background thread and synchronization
    std::thread decoderThread_;
    std::mutex decoderMutex_;
    std::condition_variable decoderCv_;
    std::atomic<bool> stopDecoder_{false};

    // Seek synchronization
    std::atomic<bool> seekPending_{false};
    std::atomic<int64_t> seekTargetFrame_{0};

    // Decoded audio cache
    std::string currentFilePath_;
    std::vector<float> decodedPcm_; // stereo interleaved floats
    std::atomic<int64_t> decodeReadHead_{0};
};

} // namespace audio_front_end
