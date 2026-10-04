#pragma once

#include <string>
#include <vector>
#include <queue>
#include <memory>
#include <atomic>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <soundio/soundio.h>
#include "ring_buffer.h"
#include "chunk_decoder.h"

namespace audio_front_end {

struct PlaybackPosition {
    bool isPlaying{false};
    double currentMs{0.0};
};

enum class DecoderCommandType {
    None,
    LoadAndPlay,
    Pause,
    Resume,
    Stop,
    Seek
};

struct DecoderCommand {
    DecoderCommandType type{DecoderCommandType::None};
    std::string filePath;
    double offsetMs{0.0};
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
    void WriteSilence(struct SoundIoOutStream* stream, int frame_count_max);

    void DecoderThreadLoop();
    void StopDecoder();

    bool LoadTrack(const std::string& filePath);
    void ExecuteSeek(int64_t targetFrame);

    // libsoundio objects - manipulated exclusively on decoderThread_ with streamMutex_
    SoundIo* soundio_{nullptr};
    SoundIoDevice* device_{nullptr};
    SoundIoOutStream* outstream_{nullptr};
    std::mutex streamMutex_;

    // Atomic playback state
    std::atomic<bool> isPlaying_{false};
    std::atomic<bool> isPaused_{false};
    std::atomic<bool> isActivelyStreaming_{false};
    std::atomic<int64_t> currentFrame_{0};
    std::atomic<int64_t> totalFrames_{0};
    std::atomic<uint32_t> sampleRate_{44100};
    std::atomic<float> volume_{1.0f};

    // Lock-free ring buffer (stereo floats)
    // Exclusively written by decoderThread_, read by SoundIo audio callback
    SpscRingBuffer<float> ringBuffer_{262144};

    // Decoder background thread and FIFO command queue
    std::thread decoderThread_;
    std::mutex commandMutex_;
    std::condition_variable decoderCv_;
    std::atomic<bool> stopDecoder_{false};
    std::queue<DecoderCommand> commandQueue_;

    // Safe flush coordination between producer (decoder) and consumer (audio callback)
    std::atomic<bool> flushRequested_{false};
    std::atomic<bool> flushAck_{false};

    // Streaming decoder state (accessed and mutated EXCLUSIVELY by decoderThread_)
    std::string currentFilePath_;
    ChunkAudioDecoder streamDecoder_;
    int64_t currentDecodedFrame_{0};
};

} // namespace audio_front_end
