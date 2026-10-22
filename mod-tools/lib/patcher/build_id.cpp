#include <fstream>
#include <sstream>

#include <error.hpp>
#include <fs.hpp>
#include <patcher/patcher.hpp>

using namespace lol;
using namespace lol::patcher;

namespace {
    constexpr char const* STAMP_NAME = ".onlyskinz-build";

    auto read_first_line(fs::path const& path) -> std::string {
        std::ifstream file(path);
        if (!file) return {};
        std::string line;
        std::getline(file, line);
        // Trim trailing CR/whitespace so a stray newline does not read as a diff.
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) {
            line.pop_back();
        }
        return line;
    }

    auto find_between(std::string const& haystack, std::string const& open, std::string const& close)
        -> std::string {
        auto start = haystack.find(open);
        if (start == std::string::npos) return {};
        start += open.size();
        auto end = haystack.find(close, start);
        if (end == std::string::npos) return {};
        return haystack.substr(start, end - start);
    }
}

auto patcher::game_build_id(fs::path const& game_path) -> std::string {
    // game_path is <install>/Contents/LoL/Game; Game.ok sits in <install>/Contents/LoL.
    auto install = game_path.parent_path();

    // Game.ok line 1 is the CDN release manifest URL. Riot rewrites it on every
    // patch, so it is the most reliable staleness signal.
    auto ok_line = read_first_line(install / "Game.ok");
    if (auto release = find_between(ok_line, "/releases/", "."); !release.empty()) {
        return "release:" + release;
    }
    if (!ok_line.empty()) return "gameok:" + ok_line;

    // Fall back to the executable's bundle version when Game.ok is missing.
    auto plist = game_path / "LeagueofLegends.app" / "Contents" / "Info.plist";
    std::ifstream file(plist);
    if (file) {
        std::stringstream buffer;
        buffer << file.rdbuf();
        auto version = find_between(buffer.str(), "<key>CFBundleVersion</key>", "</string>");
        if (auto open = version.find("<string>"); open != std::string::npos) {
            version = version.substr(open + 8);
        }
        if (!version.empty()) return "version:" + version;
    }

    return {};
}

auto patcher::read_build_stamp(fs::path const& overlay_dir) -> std::string {
    return read_first_line(overlay_dir / STAMP_NAME);
}

auto patcher::write_build_stamp(fs::path const& overlay_dir, std::string const& build_id) -> void {
    if (build_id.empty()) return;
    std::ofstream file(overlay_dir / STAMP_NAME, std::ios::trunc);
    if (!file) {
        logw("Could not write overlay build stamp in {}", overlay_dir);
        return;
    }
    file << build_id << "\n";
}

auto patcher::overlay_is_stale(fs::path const& overlay_dir, fs::path const& game_path) -> bool {
    auto stamped = read_build_stamp(overlay_dir);
    if (stamped.empty()) return false;  // Predates stamping; cannot judge.
    auto current = game_build_id(game_path);
    if (current.empty()) return false;  // Cannot identify the install; do not block.
    return stamped != current;
}
