#include <cassert>
#include <iostream>
#include <fstream>
#include <filesystem>
#include "analysis_cache.h"

namespace fs = std::filesystem;

void test_basic_cache_workflow() {
    fs::path tempDir = fs::temp_directory_path() / "test_audio_cache_basic";
    fs::create_directories(tempDir);
    fs::path sampleAudio = tempDir / "test.wav";
    {
        std::ofstream f(sampleAudio, std::ios::binary);
        f.write("RIFFtestdata", 12);
    }

    audio_front_end::AnalysisCache cache;
    
    // 1. Initial check - should be unanalyzed
    assert(!cache.HasValidCache(sampleAudio.string(), false));

    // 2. Generate dummy apv and att
    audio_codecs::preview::ApvHeader apv{};
    apv.source_file_size = 12;
    apv.duration_ms = 1000;
    apv.sample_rate = 44100;
    apv.channels = 2;

    audio_codecs::tempo::AttHeader att{};
    att.duration_ms = 1000;
    att.global_bpm_q16 = 120 << 16;

    assert(cache.WriteCache(sampleAudio.string(), apv, {}, att, {}, false));

    // 3. Cache should now be valid
    assert(cache.HasValidCache(sampleAudio.string(), false));

    // 4. Test reading cache
    audio_front_end::CachedAnalysisData data;
    assert(cache.ReadCache(sampleAudio.string(), data, false));
    assert(data.durationMs == 1000);
    assert(data.sampleRate == 44100);
    assert(data.bpm == 120.0);

    // 5. Test lightweight header-only reader
    uint32_t headerDurationMs = 0;
    double headerBpm = 0.0;
    assert(cache.ReadCacheHeader(sampleAudio.string(), headerDurationMs, headerBpm, false));
    assert(headerDurationMs == 1000);
    assert(headerBpm == 120.0);

    fs::remove_all(tempDir);
    std::cout << "test_basic_cache_workflow PASSED" << std::endl;
}

void test_path_resolution() {
    fs::path basePath = fs::path("path") / "to" / "track.wav";
    std::string audio = basePath.string();
    auto apvDefault = audio_front_end::AnalysisCache::GetApvPath(audio, false);
    auto attDefault = audio_front_end::AnalysisCache::GetAttPath(audio, false);
    assert(apvDefault == fs::path("path") / "to" / ".analysis" / "track.wav.apv");
    assert(attDefault == fs::path("path") / "to" / ".analysis" / "track.wav.att");

    auto apvFlat = audio_front_end::AnalysisCache::GetApvPath(audio, true);
    auto attFlat = audio_front_end::AnalysisCache::GetAttPath(audio, true);
    assert(apvFlat == fs::path("path") / "to" / "track.wav.apv");
    assert(attFlat == fs::path("path") / "to" / "track.wav.att");

    std::cout << "test_path_resolution PASSED" << std::endl;
}

void test_flat_sidecar_and_invalidation() {
    fs::path tempDir = fs::temp_directory_path() / "test_audio_cache_flat";
    fs::create_directories(tempDir);
    fs::path sampleAudio = tempDir / "beat.wav";
    {
        std::ofstream f(sampleAudio, std::ios::binary);
        f.write("1234567890", 10);
    }

    audio_front_end::AnalysisCache cache;
    assert(!cache.HasValidCache(sampleAudio.string(), true));

    audio_codecs::preview::ApvHeader apv{};
    apv.source_file_size = 10;
    apv.duration_ms = 2500;
    apv.sample_rate = 48000;
    apv.channels = 2;

    audio_codecs::tempo::AttHeader att{};
    att.duration_ms = 2500;
    att.global_bpm_q16 = static_cast<uint32_t>(128.5 * 65536.0);
    att.time_signature_num = 3;
    att.time_signature_denom = 4;
    att.confidence = 95;

    // Write dummy LODs
    std::vector<std::vector<int8_t>> lods(2);
    // LOD 0: 2 chunks (each 4 bytes stereo)
    lods[0] = { -50, 60, -40, 55,  -70, 80, -65, 75 };
    // LOD 1: 1 chunk
    lods[1] = { -70, 80, -65, 75 };

    // Write dummy Beat markers
    std::vector<audio_codecs::tempo::AttBeatMarker> beats(2);
    beats[0].time_ms = 0;
    beats[0].bar_index = 0;
    beats[0].beat_within_bar = 0;
    beats[0].flags = audio_codecs::tempo::ATT_BEAT_FLAG_DOWNBEAT;
    beats[0].local_bpm_q16 = static_cast<uint32_t>(128.5 * 65536.0);

    beats[1].time_ms = 467;
    beats[1].bar_index = 0;
    beats[1].beat_within_bar = 1;
    beats[1].flags = 0;
    beats[1].local_bpm_q16 = static_cast<uint32_t>(128.5 * 65536.0);

    assert(cache.WriteCache(sampleAudio.string(), apv, lods, att, beats, true));

    // Verify flat files were created
    assert(fs::exists(tempDir / "beat.wav.apv"));
    assert(fs::exists(tempDir / "beat.wav.att"));
    assert(cache.HasValidCache(sampleAudio.string(), true));

    // Read and verify data
    audio_front_end::CachedAnalysisData data;
    assert(cache.ReadCache(sampleAudio.string(), data, true));
    assert(data.durationMs == 2500);
    assert(data.sampleRate == 48000);
    assert(std::abs(data.bpm - 128.5) < 0.01);
    assert(data.confidence == 95);
    assert(data.timeSignature.first == 3);
    assert(data.timeSignature.second == 4);

    uint32_t headerDurationMs = 0;
    double headerBpm = 0.0;
    assert(cache.ReadCacheHeader(sampleAudio.string(), headerDurationMs, headerBpm, true));
    assert(headerDurationMs == 2500);
    assert(std::abs(headerBpm - 128.5) < 0.01);

    // Verify LODs
    assert(data.lods.size() == 2);
    assert(data.lods[0].chunkCount == 2);
    assert(data.lods[0].peaks == lods[0]);
    assert(data.lods[1].chunkCount == 1);
    assert(data.lods[1].peaks == lods[1]);

    // Verify beats
    assert(data.beats.size() == 2);
    assert(data.beats[0].timeMs == 0);
    assert(data.beats[0].isDownbeat == true);
    assert(data.beats[1].timeMs == 467);
    assert(data.beats[1].isDownbeat == false);

    // Test cache invalidation when audio size changes
    {
        std::ofstream f(sampleAudio, std::ios::binary | std::ios::app);
        f.write("EXTRA_BYTES", 11);
    }
    // Now audio size is 21 != 10
    assert(!cache.HasValidCache(sampleAudio.string(), true));

    fs::remove_all(tempDir);
    std::cout << "test_flat_sidecar_and_invalidation PASSED" << std::endl;
}

void test_defensive_edge_cases() {
    fs::path tempDir = fs::temp_directory_path() / "test_audio_cache_defensive";
    fs::create_directories(tempDir);
    fs::path sampleAudio = tempDir / "edge.wav";
    {
        std::ofstream f(sampleAudio, std::ios::binary);
        f.write("RIFFtestdata", 12);
    }

    audio_front_end::AnalysisCache cache;

    // 1. lodData is empty, but apv has lod_count > 0
    audio_codecs::preview::ApvHeader apv{};
    apv.source_file_size = 12;
    apv.duration_ms = 500;
    apv.sample_rate = 44100;
    apv.channels = 2;
    apv.lod_count = 3;
    apv.flags |= audio_codecs::preview::APV_FLAG_HAS_LODS;

    // beatMarkers is empty, but att has beat_grid_count > 0
    audio_codecs::tempo::AttHeader att{};
    att.duration_ms = 500;
    att.global_bpm_q16 = 120 << 16;
    att.beat_grid_count = 10;
    att.total_beats = 10;
    att.beat_grid_offset = 128;

    assert(cache.WriteCache(sampleAudio.string(), apv, {}, att, {}, false));

    // Verify ReadCache reads correctly without crashing
    audio_front_end::CachedAnalysisData data;
    assert(cache.ReadCache(sampleAudio.string(), data, false));
    assert(data.lods.empty());
    assert(data.beats.empty());

    // 2. Corrupted file test: file claims huge chunk_count exceeding file size
    fs::path apvPath = audio_front_end::AnalysisCache::GetApvPath(sampleAudio.string(), false);
    {
        audio_codecs::preview::ApvHeader corruptedApv{};
        std::ifstream in(apvPath, std::ios::binary);
        in.read(reinterpret_cast<char*>(&corruptedApv), sizeof(corruptedApv));
        in.close();

        corruptedApv.lod_count = 1;
        corruptedApv.lods[0].chunk_count = 1000000;
        corruptedApv.lods[0].file_offset = 128;

        std::ofstream out(apvPath, std::ios::binary | std::ios::trunc);
        out.write(reinterpret_cast<const char*>(&corruptedApv), sizeof(corruptedApv));
    }

    // ReadCache should safely reject the corrupted file without allocating massive memory
    audio_front_end::CachedAnalysisData corruptData;
    assert(!cache.ReadCache(sampleAudio.string(), corruptData, false));

    fs::remove_all(tempDir);
    std::cout << "test_defensive_edge_cases PASSED" << std::endl;
}

int main() {
    test_path_resolution();
    test_basic_cache_workflow();
    test_flat_sidecar_and_invalidation();
    test_defensive_edge_cases();
    std::cout << "test_analysis_cache PASSED" << std::endl;
    return 0;
}

