#pragma once
#include <string>
#include <vector>
#include <filesystem>
#include <utility>
#include <cstdint>
#include <audio_codecs/preview/preview_types.h>
#include <audio_codecs/tempo/tempo_types.h>

namespace audio_front_end {

struct CachedLod {
    uint32_t downsampleRatio{1};
    uint32_t chunkCount{0};
    std::vector<int8_t> peaks;
};

struct CachedBeat {
    uint32_t timeMs{0};
    uint32_t barIndex{0};
    uint16_t beatWithinBar{0};
    bool isDownbeat{false};
    double localBpm{0.0};
};

struct CachedAnalysisData {
    uint32_t durationMs{0};
    uint32_t sampleRate{0};
    uint8_t channels{0};
    double bpm{0.0};
    uint8_t confidence{0};
    std::pair<uint8_t, uint8_t> timeSignature{4, 4};
    std::vector<CachedLod> lods;
    std::vector<CachedBeat> beats;
};

class AnalysisCache {
public:
    static std::filesystem::path GetApvPath(const std::string& audioPath, bool flatSidecar);
    static std::filesystem::path GetAttPath(const std::string& audioPath, bool flatSidecar);
    
    bool HasValidCache(const std::string& audioPath, bool flatSidecar);
    bool ReadCache(const std::string& audioPath, CachedAnalysisData& outData, bool flatSidecar);
    bool WriteCache(const std::string& audioPath, 
                    const audio_codecs::preview::ApvHeader& apvHeader,
                    const std::vector<std::vector<int8_t>>& lodData,
                    const audio_codecs::tempo::AttHeader& attHeader,
                    const std::vector<audio_codecs::tempo::AttBeatMarker>& beatMarkers,
                    bool flatSidecar);
};

} // namespace audio_front_end
