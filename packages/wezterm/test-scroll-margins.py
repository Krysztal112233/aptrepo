#!/usr/bin/env python3
"""Check DECSLRM scrolling in an isolated WezTerm/Xvfb instance.

Requires Xvfb and ImageMagick's import command. Does not install anything or
send input to any pane. Run against a binary extracted from the built .deb:
  uv run --no-project --python /usr/bin/python3 packages/wezterm/test-scroll-margins.py \
    /path/to/usr/bin/wezterm --front-end OpenGL --artifacts /new/artifact/directory

OpenGL uses Mesa software rendering here; this cannot certify desktop Wayland
or the physical GPU driver. Inspect the saved PNG for glyph rendering too.
"""

import argparse
import json
import os
from pathlib import Path
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import time
import tty
from urllib.parse import unquote, urlsplit

COLS, ROWS, SCROLL_ROWS, LEFT_COLS = 100, 24, 20, 50


def left(row):
    return f"LEFT {row:03d} ".ljust(LEFT_COLS, ".")


def right(row):
    return f"RIGHT {row:03d} ".ljust(COLS - LEFT_COLS, ".")


def probe(root):
    """Controlled child: advance only through files in the private directory."""
    fd = sys.stdin.fileno()
    original = termios.tcgetattr(fd)
    tty.setraw(fd)
    deadline = time.monotonic() + 60

    def wait_for(name):
        while not (root / name).exists():
            if (root / "finish").exists():
                raise InterruptedError("probe stopped")
            if time.monotonic() > deadline:
                raise TimeoutError(f"waiting for {name}")
            time.sleep(0.05)

    def emit(text, marker):
        sys.stdout.write(text)
        sys.stdout.flush()
        (root / marker).touch()

    try:
        # Initial GUI sizing can reset DEC margins even when the final cell
        # dimensions are unchanged. Draw the fixture after window setup.
        time.sleep(1)
        size = os.get_terminal_size(fd)
        (root / "size.json").write_text(json.dumps({"cols": size.columns, "rows": size.lines}))
        text = "\x1b[2J\x1b[H"
        for row in range(1, ROWS + 1):
            text += f"\x1b[{row};1H" + left(row) + right(row)
        emit(text, "ready")
        wait_for("scroll-up")
        # Left margin 51 is greater than the terminal's 24 rows: the old bug
        # incorrectly bounded the horizontal margin by the row count.
        emit("\x1b[?69h\x1b[51;100s\x1b[1;20r\x1b[1;51H\x1b[1S", "scrolled-up")
        wait_for("scroll-down")
        emit("\x1b[?69h\x1b[51;100s\x1b[1;20r\x1b[1;51H\x1b[1T", "scrolled-down")
        wait_for("render-glyphs")
        emit(
            "\x1b[?69l\x1b[r\x1b[2J\x1b[H"
            "WezTerm render test: abcXYZ 0123456789\r\n"
            "中文测试 αβγ 😀\r\n"
            "\x1b[31mRED\x1b[32m GREEN\x1b[34m BLUE\x1b[0m\r\n",
            "glyphs-ready",
        )
        wait_for("finish")
    except InterruptedError:
        pass
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, original)


def run(command, env):
    result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError(f"{command!r} failed: {result.stderr.strip()}")
    return result.stdout


def stop(process):
    if process is None:
        return
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    else:
        process.wait()


def check_screen(text, stage):
    lines = text.splitlines()
    if len(lines) != ROWS:
        raise AssertionError(f"{stage}: expected {ROWS} rows, got {len(lines)}")
    for row in range(1, ROWS + 1):
        if row > SCROLL_ROWS or stage == "before":
            expected_right = right(row)
        elif stage == "up":
            expected_right = right(row + 1) if row < SCROLL_ROWS else " " * LEFT_COLS
        else:
            expected_right = " " * LEFT_COLS if row == 1 else right(row)
        expected = left(row) + expected_right
        actual = lines[row - 1].ljust(COLS)
        if actual != expected:
            raise AssertionError(
                f"{stage}: row {row} changed outside the intended region or scrolled incorrectly\n"
                f"expected: {expected!r}\nactual:   {actual!r}"
            )


def smoke(executable, front_end, root):
    runtime = root / "runtime"
    runtime.mkdir(mode=0o700)
    (root / "cache").mkdir()
    (root / "config").mkdir()
    # Inherited WezTerm connection hints must never reach either GUI or CLI.
    env = {key: value for key, value in os.environ.items() if not key.startswith("WEZTERM_")}
    for key in ("WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK"):
        env.pop(key, None)
    env.update(
        XDG_RUNTIME_DIR=str(runtime),
        XDG_CACHE_HOME=str(root / "cache"),
        XDG_CONFIG_HOME=str(root / "config"),
        XDG_SESSION_TYPE="x11",
        LIBGL_ALWAYS_SOFTWARE="1",
    )
    config = root / "wezterm.lua"
    config.write_text(
        "return {enable_wayland=false, enable_tab_bar=false, "
        "window_decorations='NONE', initial_cols=100, initial_rows=24, "
        f"font_size=14.0, front_end='{front_end}', "
        "colors={foreground='#ffffff', background='#000000'}, "
        "window_padding={left=0,right=0,top=0,bottom=0}}\n"
    )
    xvfb, gui = None, None
    try:
        read_fd, write_fd = os.pipe()
        try:
            with (root / "xvfb.log").open("w") as log:
                xvfb = subprocess.Popen(
                    ["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "1400x900x24", "-nolisten", "tcp"],
                    env=env, stdout=log, stderr=log, pass_fds=(write_fd,), start_new_session=True,
                )
            os.close(write_fd)
            write_fd = None
            if not select.select([read_fd], [], [], 10)[0]:
                raise TimeoutError("Xvfb did not allocate a display")
            display = os.read(read_fd, 32).decode().strip()
            if not display.isdigit():
                raise RuntimeError(f"invalid private Xvfb display: {display!r}")
            env["DISPLAY"] = f":{display}"
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)

        with (root / "gui.log").open("w") as log:
            gui = subprocess.Popen(
                [str(executable), "--config-file", str(config), "start", "--always-new-process",
                 "--cwd", str(root), "--", sys.executable, str(Path(__file__).resolve()),
                 "--probe-child", str(root)],
                env=env, stdout=log, stderr=log, start_new_session=True,
            )

        def wait_for(name):
            deadline = time.monotonic() + 20
            while not (root / name).exists():
                if gui.poll() is not None:
                    raise RuntimeError(f"private GUI exited; see {root / 'gui.log'}")
                if time.monotonic() > deadline:
                    raise TimeoutError(f"waiting for {name}; see {root / 'gui.log'}")
                time.sleep(0.05)

        wait_for("ready")
        if json.loads((root / "size.json").read_text()) != {"cols": COLS, "rows": ROWS}:
            raise AssertionError("private probe has an unexpected terminal size")
        sockets = [path for path in runtime.rglob("gui-sock-*") if stat.S_ISSOCK(path.lstat().st_mode)]
        if len(sockets) != 1 or not sockets[0].resolve().is_relative_to(runtime.resolve()):
            raise AssertionError(f"expected exactly one private GUI socket, got {sockets!r}")
        env["WEZTERM_UNIX_SOCKET"] = str(sockets[0])
        cli = [str(executable), "--config-file", str(config), "cli", "--no-auto-start"]
        panes_text = run(cli + ["list", "--format", "json"], env)
        (root / "panes.json").write_text(panes_text)
        panes = json.loads(panes_text)
        if len(panes) != 1 or panes[0]["pane_id"] != 0:
            raise AssertionError("private instance must contain only pane 0")
        if (panes[0]["size"]["cols"], panes[0]["size"]["rows"]) != (COLS, ROWS):
            raise AssertionError("private mux reports an unexpected terminal size")
        if Path(unquote(urlsplit(panes[0]["cwd"]).path)).resolve() != root:
            raise AssertionError("private pane cwd does not match the probe directory")

        # Read-only CLI calls only. File acknowledgements control our probe.
        for stage, acknowledgement, marker in (
            ("before", None, "ready"),
            ("up", "scroll-up", "scrolled-up"),
            ("down", "scroll-down", "scrolled-down"),
        ):
            if acknowledgement:
                (root / acknowledgement).touch()
            wait_for(marker)
            # Flushing the PTY precedes GUI consumption; wait for its model,
            # rather than mistaking one stale frame for a terminal regression.
            deadline = time.monotonic() + 3
            while True:
                text = run(cli + ["get-text", "--pane-id", "0"], env)
                (root / f"{stage}.txt").write_text(text)
                try:
                    check_screen(text, stage)
                    break
                except AssertionError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.05)
            (root / f"{stage}-panes.json").write_text(run(cli + ["list", "--format", "json"], env))

        (root / "render-glyphs").touch()
        wait_for("glyphs-ready")
        text = run(cli + ["get-text", "--pane-id", "0"], env)
        (root / "glyphs.txt").write_text(text)
        for sample in ("abcXYZ 0123456789", "中文测试 αβγ 😀", "RED GREEN BLUE"):
            if sample not in text:
                raise AssertionError(f"missing glyph sample in terminal model: {sample!r}")
        time.sleep(0.5)  # Allow a rendered frame after the child flushes.
        run(["import", "-window", "root", str(root / "glyphs.png")], env)
        print(f"PASS: {front_end}: left margin 51 on 100x24; up/down scrolling and outside rows intact")
        print(f"Artifacts: {root}")
    finally:
        (root / "finish").touch()
        if gui is not None:
            try:
                gui.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        stop(gui)
        stop(xvfb)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--probe-child":
        probe(Path(sys.argv[2]))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("--front-end", choices=("Software", "OpenGL"), default="OpenGL")
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    for command in ("Xvfb", "import"):
        if shutil.which(command) is None:
            parser.error(f"required command not found: {command}")
    executable = args.executable.resolve(strict=True)
    if not os.access(executable, os.X_OK):
        parser.error(f"not executable: {executable}")
    if args.artifacts:
        root = args.artifacts.resolve()
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
    else:
        root = Path(tempfile.mkdtemp(prefix="wezterm-margin-smoke-", dir="/var/tmp"))
    smoke(executable, args.front_end, root)


if __name__ == "__main__":
    main()
