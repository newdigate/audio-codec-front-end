#pragma once

#include <audio_codecs/wav/wav_decoder.h>
#include <audio_codecs/aiff/aiff_decoder.h>
#include <audio_codecs/mp3/mp3_decoder.h>
#include <audio_codecs/flac/flac_decoder.h>
#include <audio_codecs/vorbis/vorbis_decoder.h>
#include <audio_codecs/aac/aac_decoder.h>
#include <audio_codecs/preview/preview_stream.h>

#include <vector>
#include <string>
#include <memory>
#include <fstream>
#include <filesystem>
#include <algorithm>
#include <cstring>
#include <cmath>

namespace audio_front_end {

inline size_t SkipId3Header(const uint8_t* data, size_t size) {
    if (size >= 10 && data[0] == 'I' && data[1] == 'D' && data[2] == '3') {
        size_t tag_size = ((data[6] & 0x7F) << 21) |
                          ((data[7] & 0x7F) << 14) |
                          ((data[8] & 0x7F) << 7)  |
                          (data[9] & 0x7F);
        size_t total_id3_len = 10 + tag_size;
        if (data[5] & 0x10) {
            total_id3_len += 10;
        }
        return (total_id3_len < size) ? total_id3_len : size;
    }
    return 0;
}

enum class CodecType {
    Wav,
    Aiff,
    Mp3,
    Flac,
    Vorbis,
    Aac,
    Unknown
};

class ChunkAudioDecoder {
public:
    ChunkAudioDecoder() = default;
    ~ChunkAudioDecoder() = default;

    bool Open(const std::string& filePath) {
        Reset();

        namespace fs = std::filesystem;
        std::ifstream file(filePath, std::ios::binary | std::ios::ate);
        if (!file.is_open()) return false;
        std::streamsize fileSize = file.tellg();
        if (fileSize <= 0) return false;
        file.seekg(0, std::ios::beg);

        fileBuffer_.resize(static_cast<size_t>(fileSize));
        if (!file.read(reinterpret_cast<char*>(fileBuffer_.data()), fileSize)) {
            Reset();
            return false;
        }

        std::string ext = fs::path(filePath).extension().string();
        std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

        if (ext == ".wav" || ext == ".wave") {
            codecType_ = CodecType::Wav;
            wavDecoder_ = std::make_unique<audio_codecs::wav::WavDecoder>();
            size_t consumed = 0;
            if (!wavDecoder_->parse_stream_header(fileBuffer_.data(), fileBuffer_.size(), consumed)) {
                Reset();
                return false;
            }
            sampleRate_ = wavDecoder_->get_sample_rate();
            channels_ = wavDecoder_->get_channels();
            if (sampleRate_ == 0 || channels_ == 0 || channels_ > 2) {
                Reset();
                return false;
            }
            dataStartOffset_ = consumed;
            currentOffset_ = dataStartOffset_;
            size_t bps = (wavDecoder_->get_bit_depth() > 0) ? (wavDecoder_->get_bit_depth() / 8) : 2;
            size_t frameBytes = channels_ * bps;
            totalFrames_ = (frameBytes > 0 && fileBuffer_.size() >= dataStartOffset_) ?
                           ((fileBuffer_.size() - dataStartOffset_) / frameBytes) : 0;
        } else if (ext == ".aiff" || ext == ".aif") {
            codecType_ = CodecType::Aiff;
            aiffDecoder_ = std::make_unique<audio_codecs::aiff::AiffDecoder>();
            size_t consumed = 0;
            if (!aiffDecoder_->parse_stream_header(fileBuffer_.data(), fileBuffer_.size(), consumed)) {
                Reset();
                return false;
            }
            sampleRate_ = aiffDecoder_->get_sample_rate();
            channels_ = aiffDecoder_->get_channels();
            if (sampleRate_ == 0 || channels_ == 0 || channels_ > 2) {
                Reset();
                return false;
            }
            dataStartOffset_ = consumed;
            currentOffset_ = dataStartOffset_;
            totalFrames_ = aiffDecoder_->get_total_frames();
        } else if (ext == ".mp3") {
            codecType_ = CodecType::Mp3;
            mp3Decoder_ = std::make_unique<audio_codecs::mp3::Mp3Decoder>();
            audio_codecs::AudioConfig dummy_cfg{44100, 2, 128, false, 4};
            if (!mp3Decoder_->init(dummy_cfg)) {
                Reset();
                return false;
            }
            dataStartOffset_ = SkipId3Header(fileBuffer_.data(), fileBuffer_.size());
            currentOffset_ = dataStartOffset_;

            std::vector<float> floatChunk(4608);
            int s = mp3Decoder_->decode_frame(fileBuffer_.data() + currentOffset_,
                                              fileBuffer_.size() - currentOffset_,
                                              floatChunk.data(), floatChunk.size());
            if (s > 0) {
                uint32_t sr = 0; uint8_t ch = 0; uint32_t br = 0;
                mp3Decoder_->get_frame_info(sr, ch, br);
                sampleRate_ = (sr > 0) ? sr : 44100;
                channels_ = (ch > 0 && ch <= 2) ? ch : 2;
                if (br > 0) {
                    double sec = (static_cast<double>(fileBuffer_.size() - dataStartOffset_) * 8.0) / (br * 1000.0);
                    totalFrames_ = static_cast<uint64_t>(sec * sampleRate_);
                }
            } else {
                sampleRate_ = 44100;
                channels_ = 2;
            }
            mp3Decoder_->reset();
            audio_codecs::AudioConfig cfg{sampleRate_, channels_, 128, false, 4};
            mp3Decoder_->init(cfg);
            currentOffset_ = dataStartOffset_;
        } else if (ext == ".flac") {
            codecType_ = CodecType::Flac;
            flacDecoder_ = std::make_unique<audio_codecs::flac::FlacDecoder>();
            size_t header_len = 0;
            if (!flacDecoder_->parse_stream_header(fileBuffer_.data(), fileBuffer_.size(), header_len)) {
                Reset();
                return false;
            }
            sampleRate_ = flacDecoder_->get_sample_rate();
            channels_ = flacDecoder_->get_channels();
            if (sampleRate_ == 0 || channels_ == 0 || channels_ > 2) {
                Reset();
                return false;
            }
            totalFrames_ = flacDecoder_->get_total_samples();
            dataStartOffset_ = header_len;
            currentOffset_ = dataStartOffset_;
        } else if (ext == ".ogg" || ext == ".oga") {
            codecType_ = CodecType::Vorbis;
            vorbisDecoder_ = std::make_unique<audio_codecs::vorbis::VorbisDecoder>();
            dataStartOffset_ = 0;
            currentOffset_ = 0;

            std::vector<float> floatChunk(4096);
            for (size_t i = 0; i < fileBuffer_.size(); i += 512) {
                size_t bytes = std::min<size_t>(512, fileBuffer_.size() - i);
                vorbisDecoder_->decode_frame(fileBuffer_.data() + i, bytes, floatChunk.data(), floatChunk.size());
                if (vorbisDecoder_->has_headers()) {
                    sampleRate_ = vorbisDecoder_->get_info().sample_rate;
                    channels_ = vorbisDecoder_->get_info().channels;
                    break;
                }
            }
            if (sampleRate_ == 0) sampleRate_ = 44100;
            if (channels_ == 0 || channels_ > 2) channels_ = 2;
            vorbisDecoder_ = std::make_unique<audio_codecs::vorbis::VorbisDecoder>();
            currentOffset_ = 0;
        } else if (ext == ".aac" || ext == ".m4a") {
            codecType_ = CodecType::Aac;
            aacDecoder_ = std::make_unique<audio_codecs::aac::AacDecoder>();
            audio_codecs::AudioConfig config{44100, 2, 0, false, 0};
            if (!aacDecoder_->init(config)) {
                Reset();
                return false;
            }
            dataStartOffset_ = 0;
            currentOffset_ = 0;

            std::vector<float> floatChunk(2048);
            int s = aacDecoder_->decode_frame(fileBuffer_.data(), fileBuffer_.size(), floatChunk.data(), floatChunk.size());
            if (s > 0) {
                uint32_t sr = 0; uint8_t ch = 0; uint32_t br = 0;
                aacDecoder_->get_frame_info(sr, ch, br);
                sampleRate_ = (sr > 0) ? sr : 44100;
                channels_ = (ch > 0 && ch <= 2) ? ch : 2;
            } else {
                sampleRate_ = 44100;
                channels_ = 2;
            }
            aacDecoder_->reset();
            aacDecoder_->init(config);
            currentOffset_ = 0;
        } else {
            Reset();
            return false;
        }

        if (sampleRate_ > 0 && totalFrames_ > 0) {
            durationMs_ = static_cast<uint32_t>((totalFrames_ * 1000ULL) / sampleRate_);
        }
        return true;
    }

    void Rewind() {
        carryOverF32_.clear();
        carryOverF32Offset_ = 0;
        carryOverI16_.clear();
        carryOverI16Offset_ = 0;
        currentOffset_ = dataStartOffset_;
        switch (codecType_) {
            case CodecType::Wav:
                if (wavDecoder_) wavDecoder_->reset();
                break;
            case CodecType::Aiff:
                if (aiffDecoder_) aiffDecoder_->reset();
                break;
            case CodecType::Mp3:
                if (mp3Decoder_) {
                    mp3Decoder_->reset();
                    audio_codecs::AudioConfig cfg{sampleRate_, channels_, 128, false, 4};
                    mp3Decoder_->init(cfg);
                }
                break;
            case CodecType::Flac:
                if (flacDecoder_) flacDecoder_->reset();
                break;
            case CodecType::Vorbis:
                vorbisDecoder_ = std::make_unique<audio_codecs::vorbis::VorbisDecoder>();
                break;
            case CodecType::Aac:
                if (aacDecoder_) {
                    aacDecoder_->reset();
                    audio_codecs::AudioConfig cfg{sampleRate_, channels_, 0, false, 0};
                    aacDecoder_->init(cfg);
                }
                break;
            default:
                break;
        }
    }

    size_t DecodeChunkI16(int16_t* outPcm, size_t maxFrames) {
        if (!IsOpen() || maxFrames == 0 || channels_ == 0) return 0;

        size_t framesDecoded = 0;

        // Drain existing carry-over buffer first
        if (carryOverI16Offset_ < carryOverI16_.size()) {
            size_t availSamples = carryOverI16_.size() - carryOverI16Offset_;
            size_t availFrames = availSamples / channels_;
            size_t toTake = std::min(maxFrames, availFrames);
            std::memcpy(outPcm, carryOverI16_.data() + carryOverI16Offset_, toTake * channels_ * sizeof(int16_t));
            carryOverI16Offset_ += toTake * channels_;
            framesDecoded += toTake;
            if (carryOverI16Offset_ >= carryOverI16_.size()) {
                carryOverI16_.clear();
                carryOverI16Offset_ = 0;
            }
            if (framesDecoded >= maxFrames) {
                return framesDecoded;
            }
        }

        switch (codecType_) {
            case CodecType::Wav: {
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    int samples = wavDecoder_->decode_frame_i16(fileBuffer_.data() + currentOffset_,
                                                                fileBuffer_.size() - currentOffset_,
                                                                outPcm + framesDecoded * channels_,
                                                                (maxFrames - framesDecoded) * channels_);
                    if (samples <= 0) break;
                    currentOffset_ += wavDecoder_->get_last_frame_bytes();
                    framesDecoded += static_cast<size_t>(samples) / channels_;
                }
                return framesDecoded;
            }
            case CodecType::Aiff: {
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    int samples = aiffDecoder_->decode_frame_i16(fileBuffer_.data() + currentOffset_,
                                                                 fileBuffer_.size() - currentOffset_,
                                                                 outPcm + framesDecoded * channels_,
                                                                 (maxFrames - framesDecoded) * channels_);
                    if (samples <= 0) break;
                    currentOffset_ += aiffDecoder_->get_last_frame_bytes();
                    framesDecoded += static_cast<size_t>(samples) / channels_;
                }
                return framesDecoded;
            }
            case CodecType::Mp3: {
                float floatChunk[4608];
                int16_t i16Chunk[4608];
                while (framesDecoded < maxFrames && currentOffset_ + 4 <= fileBuffer_.size()) {
                    int samples = mp3Decoder_->decode_frame(fileBuffer_.data() + currentOffset_,
                                                            fileBuffer_.size() - currentOffset_,
                                                            floatChunk, 4608);
                    if (samples <= 0) {
                        if (samples == -3 && (mp3Decoder_->get_last_sync_offset() + mp3Decoder_->get_last_frame_bytes() > 0)) {
                            currentOffset_ += mp3Decoder_->get_last_sync_offset() + mp3Decoder_->get_last_frame_bytes();
                            continue;
                        }
                        break;
                    }
                    size_t advance = mp3Decoder_->get_last_sync_offset() + mp3Decoder_->get_last_frame_bytes();
                    if (advance == 0) advance = 4;
                    currentOffset_ += advance;

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) break;
                    for (int i = 0; i < samples; ++i) {
                        int32_t val = static_cast<int32_t>(floatChunk[i] * 32767.0f);
                        i16Chunk[i] = static_cast<int16_t>(std::clamp(val, -32768, 32767));
                    }
                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outPcm + framesDecoded * channels_, i16Chunk, toCopy * channels_ * sizeof(int16_t));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverI16_.assign(i16Chunk + toCopy * channels_, i16Chunk + newFrames * channels_);
                        carryOverI16Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Flac: {
                std::vector<int16_t> flacBuf(16384);
                while (framesDecoded < maxFrames && currentOffset_ + 4 <= fileBuffer_.size()) {
                    int samples = flacDecoder_->decode_frame_i16(fileBuffer_.data() + currentOffset_,
                                                                fileBuffer_.size() - currentOffset_,
                                                                flacBuf.data(),
                                                                flacBuf.size());
                    if (samples <= 0) break;
                    size_t advance = flacDecoder_->get_last_frame_bytes();
                    if (advance == 0) advance = 4;
                    currentOffset_ += advance;

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) break;
                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outPcm + framesDecoded * channels_, flacBuf.data(), toCopy * channels_ * sizeof(int16_t));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverI16_.assign(flacBuf.data() + toCopy * channels_, flacBuf.data() + newFrames * channels_);
                        carryOverI16Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Vorbis: {
                float floatChunk[8192];
                int16_t i16Chunk[8192];
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    size_t bytes = std::min<size_t>(512, fileBuffer_.size() - currentOffset_);
                    int samples = vorbisDecoder_->decode_frame(fileBuffer_.data() + currentOffset_, bytes, floatChunk, 8192);
                    currentOffset_ += bytes;
                    if (samples <= 0) continue;

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) continue;
                    for (int s = 0; s < samples; ++s) {
                        int32_t val = static_cast<int32_t>(floatChunk[s] * 32767.0f);
                        i16Chunk[s] = static_cast<int16_t>(std::clamp(val, -32768, 32767));
                    }
                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outPcm + framesDecoded * channels_, i16Chunk, toCopy * channels_ * sizeof(int16_t));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverI16_.assign(i16Chunk + toCopy * channels_, i16Chunk + newFrames * channels_);
                        carryOverI16Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Aac: {
                float floatChunk[4096];
                int16_t i16Chunk[4096];
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    int samples = aacDecoder_->decode_frame(fileBuffer_.data() + currentOffset_,
                                                            fileBuffer_.size() - currentOffset_,
                                                            floatChunk, 4096);
                    if (samples <= 0) break;
                    size_t frame_bytes = aacDecoder_->get_last_frame_bytes();
                    if (frame_bytes == 0) break;
                    currentOffset_ += frame_bytes + aacDecoder_->get_last_sync_offset();

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) break;
                    for (int s = 0; s < samples; ++s) {
                        int32_t val = static_cast<int32_t>(floatChunk[s] * 32767.0f);
                        i16Chunk[s] = static_cast<int16_t>(std::clamp(val, -32768, 32767));
                    }
                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outPcm + framesDecoded * channels_, i16Chunk, toCopy * channels_ * sizeof(int16_t));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverI16_.assign(i16Chunk + toCopy * channels_, i16Chunk + newFrames * channels_);
                        carryOverI16Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            default:
                return 0;
        }
    }

    size_t DecodeChunkF32Stereo(float* outStereoPcm, size_t maxFrames) {
        if (!IsOpen() || maxFrames == 0 || channels_ == 0) return 0;

        size_t framesDecoded = 0;

        // Drain existing carry-over buffer first
        if (carryOverF32Offset_ < carryOverF32_.size()) {
            size_t availSamples = carryOverF32_.size() - carryOverF32Offset_;
            size_t availFrames = availSamples / 2; // Always stereo in carryOverF32_
            size_t toTake = std::min(maxFrames, availFrames);
            std::memcpy(outStereoPcm, carryOverF32_.data() + carryOverF32Offset_, toTake * 2 * sizeof(float));
            carryOverF32Offset_ += toTake * 2;
            framesDecoded += toTake;
            if (carryOverF32Offset_ >= carryOverF32_.size()) {
                carryOverF32_.clear();
                carryOverF32Offset_ = 0;
            }
            if (framesDecoded >= maxFrames) {
                return framesDecoded;
            }
        }

        switch (codecType_) {
            case CodecType::Wav: {
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    size_t needed = maxFrames - framesDecoded;
                    if (channels_ == 1) {
                        float monoBuf[2048];
                        size_t toRead = std::min(needed, static_cast<size_t>(2048));
                        int samples = wavDecoder_->decode_frame_f32(fileBuffer_.data() + currentOffset_,
                                                                    fileBuffer_.size() - currentOffset_,
                                                                    monoBuf, toRead);
                        if (samples <= 0) break;
                        currentOffset_ += wavDecoder_->get_last_frame_bytes();
                        for (int i = 0; i < samples; ++i) {
                            outStereoPcm[(framesDecoded + i) * 2] = monoBuf[i];
                            outStereoPcm[(framesDecoded + i) * 2 + 1] = monoBuf[i];
                        }
                        framesDecoded += static_cast<size_t>(samples);
                    } else {
                        int samples = wavDecoder_->decode_frame_f32(fileBuffer_.data() + currentOffset_,
                                                                    fileBuffer_.size() - currentOffset_,
                                                                    outStereoPcm + framesDecoded * 2,
                                                                    needed * 2);
                        if (samples <= 0) break;
                        currentOffset_ += wavDecoder_->get_last_frame_bytes();
                        framesDecoded += static_cast<size_t>(samples) / 2;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Aiff: {
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    size_t needed = maxFrames - framesDecoded;
                    if (channels_ == 1) {
                        float monoBuf[2048];
                        size_t toRead = std::min(needed, static_cast<size_t>(2048));
                        int samples = aiffDecoder_->decode_frame_f32(fileBuffer_.data() + currentOffset_,
                                                                     fileBuffer_.size() - currentOffset_,
                                                                     monoBuf, toRead);
                        if (samples <= 0) break;
                        currentOffset_ += aiffDecoder_->get_last_frame_bytes();
                        for (int i = 0; i < samples; ++i) {
                            outStereoPcm[(framesDecoded + i) * 2] = monoBuf[i];
                            outStereoPcm[(framesDecoded + i) * 2 + 1] = monoBuf[i];
                        }
                        framesDecoded += static_cast<size_t>(samples);
                    } else {
                        int samples = aiffDecoder_->decode_frame_f32(fileBuffer_.data() + currentOffset_,
                                                                     fileBuffer_.size() - currentOffset_,
                                                                     outStereoPcm + framesDecoded * 2,
                                                                     needed * 2);
                        if (samples <= 0) break;
                        currentOffset_ += aiffDecoder_->get_last_frame_bytes();
                        framesDecoded += static_cast<size_t>(samples) / 2;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Mp3: {
                float floatChunk[4608];
                float stereoChunk[4608 * 2];
                while (framesDecoded < maxFrames && currentOffset_ + 4 <= fileBuffer_.size()) {
                    int samples = mp3Decoder_->decode_frame(fileBuffer_.data() + currentOffset_,
                                                            fileBuffer_.size() - currentOffset_,
                                                            floatChunk, 4608);
                    if (samples <= 0) {
                        if (samples == -3 && (mp3Decoder_->get_last_sync_offset() + mp3Decoder_->get_last_frame_bytes() > 0)) {
                            // Bit reservoir underflow on transition frame: advance and continue
                            currentOffset_ += mp3Decoder_->get_last_sync_offset() + mp3Decoder_->get_last_frame_bytes();
                            continue;
                        }
                        break;
                    }
                    size_t advance = mp3Decoder_->get_last_sync_offset() + mp3Decoder_->get_last_frame_bytes();
                    if (advance == 0) advance = 4;
                    currentOffset_ += advance;

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) break;
                    if (channels_ == 1) {
                        for (size_t f = 0; f < newFrames; ++f) {
                            stereoChunk[f * 2] = floatChunk[f];
                            stereoChunk[f * 2 + 1] = floatChunk[f];
                        }
                    } else {
                        std::memcpy(stereoChunk, floatChunk, samples * sizeof(float));
                    }

                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outStereoPcm + framesDecoded * 2, stereoChunk, toCopy * 2 * sizeof(float));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverF32_.assign(stereoChunk + toCopy * 2, stereoChunk + newFrames * 2);
                        carryOverF32Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Flac: {
                float* floatChunk = scratchF32Chunk_.data();
                float* stereoChunk = scratchStereoChunk_.data();
                while (framesDecoded < maxFrames && currentOffset_ + 4 <= fileBuffer_.size()) {
                    int samples = flacDecoder_->decode_frame(fileBuffer_.data() + currentOffset_,
                                                            fileBuffer_.size() - currentOffset_,
                                                            floatChunk,
                                                            16384);
                    if (samples <= 0) break;
                    size_t advance = flacDecoder_->get_last_frame_bytes();
                    if (advance == 0) advance = 4;
                    currentOffset_ += advance;

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) break;
                    if (channels_ == 1) {
                        for (size_t f = 0; f < newFrames; ++f) {
                            stereoChunk[f * 2] = floatChunk[f];
                            stereoChunk[f * 2 + 1] = floatChunk[f];
                        }
                    } else {
                        std::memcpy(stereoChunk, floatChunk, samples * sizeof(float));
                    }

                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outStereoPcm + framesDecoded * 2, stereoChunk, toCopy * 2 * sizeof(float));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverF32_.assign(stereoChunk + toCopy * 2, stereoChunk + newFrames * 2);
                        carryOverF32Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Vorbis: {
                float* floatChunk = scratchF32Chunk_.data();
                float* stereoChunk = scratchStereoChunk_.data();
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    size_t bytes = std::min<size_t>(512, fileBuffer_.size() - currentOffset_);
                    int samples = vorbisDecoder_->decode_frame(fileBuffer_.data() + currentOffset_, bytes, floatChunk, 8192);
                    currentOffset_ += bytes;
                    if (samples <= 0) continue;

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) continue;
                    if (channels_ == 1) {
                        for (size_t f = 0; f < newFrames; ++f) {
                            stereoChunk[f * 2] = floatChunk[f];
                            stereoChunk[f * 2 + 1] = floatChunk[f];
                        }
                    } else {
                        std::memcpy(stereoChunk, floatChunk, samples * sizeof(float));
                    }

                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outStereoPcm + framesDecoded * 2, stereoChunk, toCopy * 2 * sizeof(float));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverF32_.assign(stereoChunk + toCopy * 2, stereoChunk + newFrames * 2);
                        carryOverF32Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            case CodecType::Aac: {
                float* floatChunk = scratchF32Chunk_.data();
                float* stereoChunk = scratchStereoChunk_.data();
                while (framesDecoded < maxFrames && currentOffset_ < fileBuffer_.size()) {
                    int samples = aacDecoder_->decode_frame(fileBuffer_.data() + currentOffset_,
                                                            fileBuffer_.size() - currentOffset_,
                                                            floatChunk,
                                                            4096);
                    if (samples <= 0) break;
                    size_t frame_bytes = aacDecoder_->get_last_frame_bytes();
                    if (frame_bytes == 0) break;
                    currentOffset_ += frame_bytes + aacDecoder_->get_last_sync_offset();

                    size_t newFrames = static_cast<size_t>(samples) / channels_;
                    if (newFrames == 0) break;
                    if (channels_ == 1) {
                        for (size_t f = 0; f < newFrames; ++f) {
                            stereoChunk[f * 2] = floatChunk[f];
                            stereoChunk[f * 2 + 1] = floatChunk[f];
                        }
                    } else {
                        std::memcpy(stereoChunk, floatChunk, samples * sizeof(float));
                    }

                    size_t needed = maxFrames - framesDecoded;
                    size_t toCopy = std::min(newFrames, needed);
                    std::memcpy(outStereoPcm + framesDecoded * 2, stereoChunk, toCopy * 2 * sizeof(float));
                    framesDecoded += toCopy;
                    if (newFrames > toCopy) {
                        carryOverF32_.assign(stereoChunk + toCopy * 2, stereoChunk + newFrames * 2);
                        carryOverF32Offset_ = 0;
                        break;
                    }
                }
                return framesDecoded;
            }
            default:
                return 0;
        }
    }

    bool SeekFrame(int64_t targetFrame) {
        if (!IsOpen()) return false;
        if (targetFrame < 0) targetFrame = 0;

        if (codecType_ == CodecType::Wav && wavDecoder_) {
            carryOverF32_.clear();
            carryOverF32Offset_ = 0;
            carryOverI16_.clear();
            carryOverI16Offset_ = 0;
            size_t bps = (wavDecoder_->get_bit_depth() > 0) ? (wavDecoder_->get_bit_depth() / 8) : 2;
            size_t frameBytes = channels_ * bps;
            currentOffset_ = dataStartOffset_ + static_cast<size_t>(targetFrame) * frameBytes;
            if (currentOffset_ > fileBuffer_.size()) currentOffset_ = fileBuffer_.size();
            return true;
        }

        if (codecType_ == CodecType::Aiff && aiffDecoder_) {
            carryOverF32_.clear();
            carryOverF32Offset_ = 0;
            carryOverI16_.clear();
            carryOverI16Offset_ = 0;
            size_t bps = (aiffDecoder_->get_bit_depth() > 0) ? (aiffDecoder_->get_bit_depth() / 8) : 2;
            size_t frameBytes = channels_ * bps;
            currentOffset_ = dataStartOffset_ + static_cast<size_t>(targetFrame) * frameBytes;
            if (currentOffset_ > fileBuffer_.size()) currentOffset_ = fileBuffer_.size();
            return true;
        }

        // For streaming compressed formats: rewind and fast-forward to target frame
        Rewind();
        if (targetFrame > 0) {
            int64_t skipped = 0;
            float discardBuf[8192]; // 4096 stereo frames on stack (no overlap with decoder scratch buffers)
            while (skipped < targetFrame) {
                size_t toSkip = std::min<size_t>(static_cast<size_t>(targetFrame - skipped), 4096);
                size_t decoded = DecodeChunkF32Stereo(discardBuf, toSkip);
                if (decoded == 0) break;
                skipped += static_cast<int64_t>(decoded);
            }
        }
        return true;
    }

    bool IsOpen() const {
        return codecType_ != CodecType::Unknown && !fileBuffer_.empty();
    }

    bool IsEof() const {
        return currentOffset_ >= fileBuffer_.size() &&
               carryOverF32Offset_ >= carryOverF32_.size() &&
               carryOverI16Offset_ >= carryOverI16_.size();
    }

    uint32_t GetSampleRate() const { return sampleRate_; }
    uint8_t GetChannels() const { return channels_; }
    uint64_t GetTotalFrames() const { return totalFrames_; }
    uint32_t GetDurationMs() const { return durationMs_; }
    CodecType GetCodecType() const { return codecType_; }

private:
    void Reset() {
        codecType_ = CodecType::Unknown;
        sampleRate_ = 0;
        channels_ = 0;
        totalFrames_ = 0;
        durationMs_ = 0;
        dataStartOffset_ = 0;
        currentOffset_ = 0;
        fileBuffer_.clear();
        carryOverF32_.clear();
        carryOverF32Offset_ = 0;
        carryOverI16_.clear();
        carryOverI16Offset_ = 0;
        wavDecoder_.reset();
        aiffDecoder_.reset();
        mp3Decoder_.reset();
        flacDecoder_.reset();
        vorbisDecoder_.reset();
        aacDecoder_.reset();
    }

    CodecType codecType_{CodecType::Unknown};
    uint32_t sampleRate_{0};
    uint8_t channels_{0};
    uint64_t totalFrames_{0};
    uint32_t durationMs_{0};
    size_t dataStartOffset_{0};
    size_t currentOffset_{0};
    std::vector<uint8_t> fileBuffer_;

    std::vector<float> carryOverF32_;
    size_t carryOverF32Offset_{0};
    std::vector<int16_t> carryOverI16_;
    size_t carryOverI16Offset_{0};

    // Persistent scratch buffers to avoid dynamic heap allocation during chunk decoding
    std::vector<float> scratchF32Chunk_{16384};
    std::vector<float> scratchStereoChunk_{32768};

    std::unique_ptr<audio_codecs::wav::WavDecoder> wavDecoder_;
    std::unique_ptr<audio_codecs::aiff::AiffDecoder> aiffDecoder_;
    std::unique_ptr<audio_codecs::mp3::Mp3Decoder> mp3Decoder_;
    std::unique_ptr<audio_codecs::flac::FlacDecoder> flacDecoder_;
    std::unique_ptr<audio_codecs::vorbis::VorbisDecoder> vorbisDecoder_;
    std::unique_ptr<audio_codecs::aac::AacDecoder> aacDecoder_;
};

class StreamingAudioPcmReader : public audio_codecs::preview::SeekableReader {
public:
    explicit StreamingAudioPcmReader(ChunkAudioDecoder& decoder) : decoder_(decoder) {
        size_t ch = decoder_.GetChannels() ? decoder_.GetChannels() : 2;
        chunkBuf_.resize(8192 * ch);
    }

    size_t read(uint8_t* dest, size_t bytes) override {
        size_t bytesRead = 0;
        size_t ch = decoder_.GetChannels();
        if (ch == 0) return 0;

        while (bytesRead < bytes) {
            if (chunkHead_ >= chunkTail_) {
                size_t frames = decoder_.DecodeChunkI16(chunkBuf_.data(), 8192);
                chunkHead_ = 0;
                chunkTail_ = frames * ch;
                if (frames == 0) {
                    eofReached_ = true;
                    break;
                }
            }

            size_t availSamples = chunkTail_ - chunkHead_;
            size_t availBytes = availSamples * sizeof(int16_t);
            size_t toCopy = std::min(bytes - bytesRead, availBytes);

            std::memcpy(dest + bytesRead, reinterpret_cast<const uint8_t*>(&chunkBuf_[chunkHead_]), toCopy);
            bytesRead += toCopy;
            chunkHead_ += toCopy / sizeof(int16_t);
        }

        streamPos_ += bytesRead;
        return bytesRead;
    }

    bool seek(uint64_t position) override {
        if (position == 0) {
            decoder_.Rewind();
            chunkHead_ = 0;
            chunkTail_ = 0;
            streamPos_ = 0;
            eofReached_ = false;
            return true;
        }
        return false;
    }

    uint64_t position() const override {
        return streamPos_;
    }

    uint64_t size() const override {
        if (eofReached_) return streamPos_;
        return decoder_.GetTotalFrames() * decoder_.GetChannels() * sizeof(int16_t);
    }

private:
    ChunkAudioDecoder& decoder_;
    std::vector<int16_t> chunkBuf_;
    size_t chunkHead_{0};
    size_t chunkTail_{0};
    uint64_t streamPos_{0};
    bool eofReached_{false};
};

} // namespace audio_front_end
