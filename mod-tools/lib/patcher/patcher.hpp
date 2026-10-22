#pragma once

#include <functional>
#include <string>
#include <common.hpp>
#include <fs.hpp>

namespace lol::patcher {
    /// Writes one diagnostic line to stderr, which OnlySkinz captures and echoes.
    void patch_log(char const* fmt, ...) noexcept __attribute__((format(printf, 1, 2)));

    /// Resumes a game frozen by Process::Suspend(). Call from a termination
    /// handler: a suspend count outlives the process that took it, so dying
    /// mid-patch would otherwise leave the game frozen for good.
    void emergency_resume() noexcept;

    /// Identity of the installed League build. Riot rewrites the release ID on
    /// every patch, so a change here means any existing overlay WAD is stale.
    /// Returns an empty string when the install cannot be identified.
    auto game_build_id(fs::path const& game_path) -> std::string;

    /// Build identity recorded next to an overlay when it was built. Empty when
    /// the overlay predates stamping (callers should then skip the check).
    auto read_build_stamp(fs::path const& overlay_dir) -> std::string;

    auto write_build_stamp(fs::path const& overlay_dir, std::string const& build_id) -> void;

    /// True when the game has been patched since the overlay was built. False
    /// when either identity is unknown, so an unstamped overlay is not blocked.
    auto overlay_is_stale(fs::path const& overlay_dir, fs::path const& game_path) -> bool;

    enum Message {
        M_WAIT_START,
        M_FOUND,
        M_WAIT_INIT,
        M_SCAN,
        M_NEED_SAVE,
        M_WAIT_PATCHABLE,
        M_PATCH,
        M_WAIT_EXIT,
        M_DONE,
        M_STALE_OVERLAY,
        M_COUNT_OF,
    };

    static constexpr const char* const STATUS_MSG[Message::M_COUNT_OF] = {
        "Waiting for league match to start",
        "Found League",
        "Wait initialized",
        "Scanning",
        "Saving",
        "Wait patchable",
        "Patching",
        "Waiting for exit",
        "League exited",
        "Overlay is stale",
    };

    extern auto run(std::function<void(Message, char const*)> update,
                    fs::path const& profile_path,
                    fs::path const& config_path,
                    fs::path const& game_path,
                    fs::names const& opts) -> void;

    struct PatcherTimeout : std::runtime_error {
        using std::runtime_error::runtime_error;
    };

    struct PatcherAborted : std::runtime_error {
        PatcherAborted() : std::runtime_error("Aborted as expected") {}
    };

    /// Thrown when the overlay was built for a different game build than the one
    /// currently installed. Injection must not proceed: serving stale WADs makes
    /// the client fail the mount and trigger a repair loop.
    struct PatcherStaleOverlay : std::runtime_error {
        using std::runtime_error::runtime_error;
    };
}
