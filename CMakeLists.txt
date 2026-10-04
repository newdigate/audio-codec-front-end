cmake_minimum_required(VERSION 3.16)
project(audio_native LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# 1. audio-codecs dependency
set(AUDIO_CODECS_LOCAL_PATH "/Users/moolet/Development/github/newdigate/audio-codecs" CACHE PATH "Path to local audio-codecs")
if(EXISTS "${AUDIO_CODECS_LOCAL_PATH}/CMakeLists.txt")
    message(STATUS "Using local audio-codecs from: ${AUDIO_CODECS_LOCAL_PATH}")
    add_subdirectory("${AUDIO_CODECS_LOCAL_PATH}" audio_codecs_build EXCLUDE_FROM_ALL)
    set(AUDIO_CODECS_INCLUDE_DIR "${AUDIO_CODECS_LOCAL_PATH}/include")
    set(AUDIO_CODECS_ROOT_DIR "${AUDIO_CODECS_LOCAL_PATH}")
else()
    include(FetchContent)
    FetchContent_Declare(
        audio_codecs
        GIT_REPOSITORY https://github.com/newdigate/audio-codecs.git
        GIT_TAG main
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(audio_codecs)
    set(AUDIO_CODECS_INCLUDE_DIR "${audio_codecs_SOURCE_DIR}/include")
    set(AUDIO_CODECS_ROOT_DIR "${audio_codecs_SOURCE_DIR}")
endif()

# 2. libsoundio dependency
find_library(SOUNDIO_LIBRARY NAMES soundio PATHS /usr/local/lib /opt/homebrew/lib)
find_path(SOUNDIO_INCLUDE_DIR NAMES soundio/soundio.h PATHS /usr/local/include /opt/homebrew/include)
if(NOT SOUNDIO_LIBRARY OR NOT SOUNDIO_INCLUDE_DIR)
    message(FATAL_ERROR "libsoundio not found. Please install libsoundio (e.g. brew install libsoundio)")
endif()
message(STATUS "Found libsoundio: ${SOUNDIO_LIBRARY} (headers: ${SOUNDIO_INCLUDE_DIR})")

# 3. Node-API Target
include_directories(
    ${CMAKE_JS_INC}
    ${SOUNDIO_INCLUDE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/src/native
    ${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api
    ${AUDIO_CODECS_INCLUDE_DIR}
    ${AUDIO_CODECS_ROOT_DIR}
)

file(GLOB_RECURSE SOURCE_FILES "src/native/*.cpp")

add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

target_link_libraries(${PROJECT_NAME} PRIVATE
    ${SOUNDIO_LIBRARY}
    audio_codecs_wav
    audio_codecs_aiff
    audio_codecs_mp3
    audio_codecs_flac
    audio_codecs_vorbis
    audio_codecs_aac
    audio_codecs_spectrum
    audio_codecs_preview
    audio_codecs_tempo
)

# 4. Native Tests
enable_testing()
add_executable(test_analysis_cache
    tests/native/test_analysis_cache.cpp
    src/native/analysis_cache.cpp
)
target_include_directories(test_analysis_cache PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src/native
    ${AUDIO_CODECS_INCLUDE_DIR}
)
target_link_libraries(test_analysis_cache PRIVATE
    audio_codecs_preview
    audio_codecs_tempo
)
set_target_properties(test_analysis_cache PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/tests"
)
add_test(NAME AnalysisCacheTest COMMAND test_analysis_cache)

