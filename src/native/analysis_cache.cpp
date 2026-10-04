#include "analysis_cache.h"
#include <fstream>
#include <cstring>
#include <algorithm>

namespace audio_front_end {

namespace {

bool FindAnalysisPaths(const std::string& audioPath, bool flatSidecar,
                       std::filesystem::path& outApv, std::filesystem::path& outAtt) {
    namespace fs = std::filesystem;
    fs::path p(audioPath);
    std::string filename = p.filename().string();
    std::string stem = p.stem().string();
    fs::path dir = p.parent_path();

    std::vector<std::pair<fs::path, fs::path>> candidates;
    if (!flatSidecar) {
        // 1. Preferred: .analysis/ subdirectory with full filename
        candidates.push_back({ dir / ".analysis" / (filename + ".apv"), dir / ".analysis" / (filename + ".att") });
        // 2. Fallback: flat sidecar with full filename
        candidates.push_back({ dir / (filename + ".apv"), dir / (filename + ".att") });
        // 3. Fallback: flat sidecar with stem only
        candidates.push_back({ dir / (stem + ".apv"), dir / (stem + ".att") });
    } else {
        // 1. Preferred: flat sidecar with full filename
        candidates.push_back({ dir / (filename + ".apv"), dir / (filename + ".att") });
        // 2. Fallback: flat sidecar with stem only
        candidates.push_back({ dir / (stem + ".apv"), dir / (stem + ".att") });
        // 3. Fallback: .analysis/ subdirectory with full filename
        candidates.push_back({ dir / ".analysis" / (filename + ".apv"), dir / ".analysis" / (filename + ".att") });
    }

    std::error_code ec;
    for (const auto& pair : candidates) {
        if (fs::exists(pair.first, ec) && fs::is_regular_file(pair.first, ec) &&
            fs::exists(pair.second, ec) && fs::is_regular_file(pair.second, ec)) {
            outApv = pair.first;
            outAtt = pair.second;
            return true;
        }
    }
    return false;
}

} // anonymous namespace

std::filesystem::path AnalysisCache::GetApvPath(const std::string& audioPath, bool flatSidecar) {
    std::filesystem::path p(audioPath);
    if (flatSidecar) {
        return p.parent_path() / (p.filename().string() + ".apv");
    } else {
        return p.parent_path() / ".analysis" / (p.filename().string() + ".apv");
    }
}

std::filesystem::path AnalysisCache::GetAttPath(const std::string& audioPath, bool flatSidecar) {
    std::filesystem::path p(audioPath);
    if (flatSidecar) {
        return p.parent_path() / (p.filename().string() + ".att");
    } else {
        return p.parent_path() / ".analysis" / (p.filename().string() + ".att");
    }
}

bool AnalysisCache::HasValidCache(const std::string& audioPath, bool flatSidecar) {
    namespace fs = std::filesystem;
    std::error_code ec;
    if (!fs::exists(audioPath, ec) || !fs::is_regular_file(audioPath, ec)) {
        return false;
    }

    uintmax_t audioSize = fs::file_size(audioPath, ec);
    if (ec) return false;

    fs::path apvPath, attPath;
    if (!FindAnalysisPaths(audioPath, flatSidecar, apvPath, attPath)) {
        return false;
    }

    if (fs::file_size(apvPath, ec) < sizeof(audio_codecs::preview::ApvHeader) || ec) {
        return false;
    }
    if (fs::file_size(attPath, ec) < sizeof(audio_codecs::tempo::AttHeader) || ec) {
        return false;
    }

    // Validate APV header
    {
        std::ifstream apvFile(apvPath, std::ios::binary);
        if (!apvFile.is_open()) return false;

        audio_codecs::preview::ApvHeader apvHdr{};
        if (!apvFile.read(reinterpret_cast<char*>(&apvHdr), sizeof(apvHdr))) {
            return false;
        }
        if (apvHdr.magic != audio_codecs::preview::APV_MAGIC ||
            apvHdr.version != audio_codecs::preview::APV_VERSION) {
            return false;
        }
        if (apvHdr.source_file_size != static_cast<uint32_t>(audioSize)) {
            return false;
        }
    }

    // Validate ATT header
    {
        std::ifstream attFile(attPath, std::ios::binary);
        if (!attFile.is_open()) return false;

        audio_codecs::tempo::AttHeader attHdr{};
        if (!attFile.read(reinterpret_cast<char*>(&attHdr), sizeof(attHdr))) {
            return false;
        }
        if (std::memcmp(attHdr.magic, audio_codecs::tempo::ATT_MAGIC, 4) != 0 ||
            attHdr.version != audio_codecs::tempo::ATT_VERSION) {
            return false;
        }
        if (attHdr.header_size < sizeof(audio_codecs::tempo::AttHeader)) {
            return false;
        }
    }

    return true;
}

bool AnalysisCache::ReadCache(const std::string& audioPath, CachedAnalysisData& outData, bool flatSidecar) {
    namespace fs = std::filesystem;
    fs::path apvPath, attPath;
    if (!FindAnalysisPaths(audioPath, flatSidecar, apvPath, attPath)) {
        return false;
    }

    audio_codecs::preview::ApvHeader apvHdr{};
    {
        std::ifstream apvFile(apvPath, std::ios::binary);
        if (!apvFile.is_open()) return false;
        if (!apvFile.read(reinterpret_cast<char*>(&apvHdr), sizeof(apvHdr))) {
            return false;
        }
        if (apvHdr.magic != audio_codecs::preview::APV_MAGIC ||
            apvHdr.version != audio_codecs::preview::APV_VERSION) {
            return false;
        }

        outData.lods.clear();
        uint8_t lodCount = std::min(apvHdr.lod_count, static_cast<uint8_t>(4));
        for (uint8_t i = 0; i < lodCount; ++i) {
            const auto& desc = apvHdr.lods[i];
            CachedLod lod;
            lod.downsampleRatio = desc.downsample_ratio;
            lod.chunkCount = desc.chunk_count;
            if (desc.chunk_count > 0 && desc.file_offset >= sizeof(audio_codecs::preview::ApvHeader)) {
                size_t bpc = apvHdr.bytes_per_chunk ? apvHdr.bytes_per_chunk : (apvHdr.channels == 2 ? 4 : 2);
                size_t totalBytes = static_cast<size_t>(desc.chunk_count) * bpc;
                lod.peaks.resize(totalBytes);
                apvFile.seekg(desc.file_offset);
                if (!apvFile.read(reinterpret_cast<char*>(lod.peaks.data()), totalBytes)) {
                    return false;
                }
            }
            outData.lods.push_back(std::move(lod));
        }
    }

    audio_codecs::tempo::AttHeader attHdr{};
    {
        std::ifstream attFile(attPath, std::ios::binary);
        if (!attFile.is_open()) return false;
        if (!attFile.read(reinterpret_cast<char*>(&attHdr), sizeof(attHdr))) {
            return false;
        }
        if (std::memcmp(attHdr.magic, audio_codecs::tempo::ATT_MAGIC, 4) != 0 ||
            attHdr.version != audio_codecs::tempo::ATT_VERSION) {
            return false;
        }

        outData.beats.clear();
        if (attHdr.beat_grid_count > 0 && attHdr.beat_grid_offset >= sizeof(audio_codecs::tempo::AttHeader)) {
            attFile.seekg(attHdr.beat_grid_offset);
            size_t markerSize = attHdr.beat_marker_size ? attHdr.beat_marker_size : sizeof(audio_codecs::tempo::AttBeatMarker);
            if (markerSize == sizeof(audio_codecs::tempo::AttBeatMarker)) {
                std::vector<audio_codecs::tempo::AttBeatMarker> markers(attHdr.beat_grid_count);
                size_t totalBytes = attHdr.beat_grid_count * sizeof(audio_codecs::tempo::AttBeatMarker);
                if (!attFile.read(reinterpret_cast<char*>(markers.data()), totalBytes)) {
                    return false;
                }
                outData.beats.reserve(attHdr.beat_grid_count);
                double globalBpm = static_cast<double>(attHdr.global_bpm_q16) / 65536.0;
                for (const auto& m : markers) {
                    CachedBeat b;
                    b.timeMs = m.time_ms;
                    b.barIndex = m.bar_index;
                    b.beatWithinBar = m.beat_within_bar;
                    b.isDownbeat = (m.flags & audio_codecs::tempo::ATT_BEAT_FLAG_DOWNBEAT) != 0;
                    b.localBpm = m.local_bpm_q16 > 0 ? (static_cast<double>(m.local_bpm_q16) / 65536.0) : globalBpm;
                    outData.beats.push_back(b);
                }
            }
        }
    }

    outData.durationMs = apvHdr.duration_ms ? apvHdr.duration_ms : attHdr.duration_ms;
    outData.sampleRate = apvHdr.sample_rate ? apvHdr.sample_rate : attHdr.sample_rate;
    outData.channels = apvHdr.channels;
    outData.bpm = static_cast<double>(attHdr.global_bpm_q16) / 65536.0;
    outData.confidence = attHdr.confidence;
    outData.timeSignature = {
        attHdr.time_signature_num == 0 ? static_cast<uint8_t>(4) : attHdr.time_signature_num,
        attHdr.time_signature_denom == 0 ? static_cast<uint8_t>(4) : attHdr.time_signature_denom
    };

    return true;
}

bool AnalysisCache::WriteCache(const std::string& audioPath, 
                               const audio_codecs::preview::ApvHeader& apvHeader,
                               const std::vector<std::vector<int8_t>>& lodData,
                               const audio_codecs::tempo::AttHeader& attHeader,
                               const std::vector<audio_codecs::tempo::AttBeatMarker>& beatMarkers,
                               bool flatSidecar) {
    namespace fs = std::filesystem;
    fs::path apvPath = GetApvPath(audioPath, flatSidecar);
    fs::path attPath = GetAttPath(audioPath, flatSidecar);

    std::error_code ec;
    if (apvPath.has_parent_path()) {
        fs::create_directories(apvPath.parent_path(), ec);
        if (ec) return false;
    }
    if (attPath.has_parent_path()) {
        fs::create_directories(attPath.parent_path(), ec);
        if (ec) return false;
    }

    // 1. Prepare and write APV
    audio_codecs::preview::ApvHeader apvCopy = apvHeader;
    apvCopy.magic = audio_codecs::preview::APV_MAGIC;
    apvCopy.version = audio_codecs::preview::APV_VERSION;
    if (apvCopy.channels == 0) apvCopy.channels = 2;
    if (apvCopy.bytes_per_chunk == 0) apvCopy.bytes_per_chunk = (apvCopy.channels == 1 ? 2 : 4);
    if (apvCopy.samples_per_base_chunk == 0) apvCopy.samples_per_base_chunk = audio_codecs::preview::BASE_CHUNK_FRAMES;
    if (apvCopy.sample_rate == 0) apvCopy.sample_rate = 44100;
    if (apvCopy.channels == 2) {
        apvCopy.flags |= audio_codecs::preview::APV_FLAG_STEREO;
    }
    if (apvCopy.source_file_size == 0 && fs::exists(audioPath, ec) && fs::is_regular_file(audioPath, ec)) {
        apvCopy.source_file_size = static_cast<uint32_t>(fs::file_size(audioPath, ec));
    }

    if (!lodData.empty()) {
        apvCopy.flags |= audio_codecs::preview::APV_FLAG_HAS_LODS;
        apvCopy.lod_count = static_cast<uint8_t>(std::min(lodData.size(), static_cast<size_t>(4)));
        uint64_t currentOffset = sizeof(audio_codecs::preview::ApvHeader);
        static const uint32_t defaultRatios[4] = { 1, 16, 256, 4096 };
        for (size_t i = 0; i < apvCopy.lod_count; ++i) {
            if (apvCopy.lods[i].downsample_ratio == 0) {
                apvCopy.lods[i].downsample_ratio = defaultRatios[i];
            }
            apvCopy.lods[i].chunk_count = static_cast<uint32_t>(lodData[i].size() / apvCopy.bytes_per_chunk);
            apvCopy.lods[i].file_offset = currentOffset;
            currentOffset += lodData[i].size();
        }
    }

    {
        std::ofstream apvFile(apvPath, std::ios::binary | std::ios::trunc);
        if (!apvFile.is_open()) return false;
        if (!apvFile.write(reinterpret_cast<const char*>(&apvCopy), sizeof(apvCopy))) {
            return false;
        }
        for (size_t i = 0; i < apvCopy.lod_count; ++i) {
            if (!lodData[i].empty()) {
                if (!apvFile.write(reinterpret_cast<const char*>(lodData[i].data()), lodData[i].size())) {
                    return false;
                }
            }
        }
        apvFile.flush();
        if (!apvFile.good()) return false;
    }

    // 2. Prepare and write ATT
    audio_codecs::tempo::AttHeader attCopy = attHeader;
    std::memcpy(attCopy.magic, audio_codecs::tempo::ATT_MAGIC, 4);
    attCopy.version = audio_codecs::tempo::ATT_VERSION;
    attCopy.header_size = sizeof(audio_codecs::tempo::AttHeader);
    if (attCopy.time_signature_num == 0) attCopy.time_signature_num = 4;
    if (attCopy.time_signature_denom == 0) attCopy.time_signature_denom = 4;
    if (attCopy.sample_rate == 0) attCopy.sample_rate = apvCopy.sample_rate;
    if (attCopy.duration_ms == 0) attCopy.duration_ms = apvCopy.duration_ms;

    if (!beatMarkers.empty()) {
        attCopy.beat_grid_count = static_cast<uint32_t>(beatMarkers.size());
        attCopy.total_beats = attCopy.beat_grid_count;
        attCopy.beat_marker_size = sizeof(audio_codecs::tempo::AttBeatMarker);
        attCopy.beat_grid_offset = sizeof(audio_codecs::tempo::AttHeader);
    }

    {
        std::ofstream attFile(attPath, std::ios::binary | std::ios::trunc);
        if (!attFile.is_open()) return false;
        if (!attFile.write(reinterpret_cast<const char*>(&attCopy), sizeof(attCopy))) {
            return false;
        }
        if (!beatMarkers.empty()) {
            size_t totalBytes = beatMarkers.size() * sizeof(audio_codecs::tempo::AttBeatMarker);
            if (!attFile.write(reinterpret_cast<const char*>(beatMarkers.data()), totalBytes)) {
                return false;
            }
        }
        attFile.flush();
        if (!attFile.good()) return false;
    }

    return true;
}

} // namespace audio_front_end
