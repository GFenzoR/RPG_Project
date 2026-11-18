"""The music driver against a fake page and a fake clock: when a wait ends, what a fetch keeps, what a busy browser leaves."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import types
import unittest
from unittest import mock

import music_web
import page_rules as rules

CONVERSATION = "https://gemini.google.com/app/abcdef1234"
TRACK = "https://contribution.usercontent.google.com/download?filename=Harbour.mp4"


class Clock:
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now


class GeneratingPage:
    """A conversation whose reply holds `text` with the stop button up until
    `track_at` seconds, and the track after it."""

    def __init__(self, clock, text, track_at):
        self.clock = clock
        self.start = clock.now
        self.text = text
        self.track_at = track_at
        self.url = CONVERSATION

    def wait_for_timeout(self, ms):
        self.clock.now += ms / 1000.0

    def evaluate(self, _script, _arg=None):
        done = self.clock.now - self.start >= self.track_at
        return {
            "media": [{"src": TRACK, "music": True}] if done else [],
            "labels": [] if done else ["Detener respuesta"],
            "text": self.text,
            "replies": 1,
            "asked": 1,
            "music_elements": 1,
            "mode": "Ayuda todos los días 4 Hydrogen",
            "composer": 0,
        }


class TheWait(unittest.TestCase):
    def wait(self, text, track_at=100.0):
        clock = Clock()
        page = GeneratingPage(clock, text, track_at)
        with mock.patch.object(music_web, "time", types.SimpleNamespace(time=clock.time)), \
                mock.patch.object(music_web.web, "say", lambda _line: None):
            outcome, src, _st = music_web.wait_for_track(page, set(), 720.0, rules.DEFAULT_MODES)
        return outcome, src, clock.now - page.start

    def test_a_brief_that_says_limited_does_not_end_a_track_being_made(self):
        # 2026-11-18 review: "limited" read as the quota and the wait ended at
        # 50 s, the tab closed on a track that took 75-130 s.
        outcome, src, took = self.wait("Generando tu pista: a slow harbour theme, limited percussion, warm strings.")
        self.assertEqual((outcome, src), ("ok", TRACK))
        self.assertGreaterEqual(took, 100.0)

    def test_a_brief_that_says_limit_in_passing_does_not_either(self):
        outcome, _src, _took = self.wait("A calm theme with no limit to its quiet, for a harbour at dusk.")
        self.assertEqual(outcome, "ok")

    def test_a_stated_quota_still_ends_a_wait_the_page_never_finishes(self):
        outcome, _src, took = self.wait("Has alcanzado el límite. El límite se restablece a las 14:30.", track_at=10000.0)
        self.assertEqual(outcome, "quota")
        self.assertLess(took, 120.0)


class TheFetch(unittest.TestCase):
    def test_a_fetch_that_never_read_the_page_keeps_the_asks_outcome(self):
        earlier = {"kind": "music", "outcome": "timeout", "url": CONVERSATION}
        failed = {"kind": "fetch", "url": CONVERSATION, "outcome": "", "fetch_error": "no Chrome answers"}
        merged = music_web.merged_fetch(earlier, failed)
        self.assertEqual(merged["outcome"], "timeout")
        self.assertEqual(merged["fetched"][-1]["fetch_error"], "no Chrome answers")

    def test_a_fetch_that_found_the_track_brings_it_in(self):
        earlier = {"kind": "music", "outcome": "timeout", "url": CONVERSATION}
        found = {"kind": "fetch", "outcome": "ok", "sha256": "ab" * 32, "bytes": 10, "title": "Harbour"}
        merged = music_web.merged_fetch(earlier, found)
        self.assertEqual((merged["outcome"], merged["sha256"], merged["title"]), ("ok", "ab" * 32, "Harbour"))


class TheBusyBrowser(unittest.TestCase):
    def test_an_ask_that_never_got_the_browser_leaves_a_busy_sidecar(self):
        with tempfile.TemporaryDirectory() as folder:
            args = argparse.Namespace(ref=[], prompt="A calm harbour theme at dusk.", modes="", name="puerto_1",
                                      out_dir=folder, slot="puerto", lock_wait=0.0, seen="", no_tool=False,
                                      wait=1.0, cdp="http://127.0.0.1:1")
            with mock.patch.object(music_web.browser_lock, "take", lambda wait: False):
                self.assertEqual(music_web.do_ask(args), rules.BUSY)
            with open(os.path.join(folder, "puerto_1.json"), encoding="utf-8") as handle:
                record = json.load(handle)
            self.assertEqual(record["outcome"], "busy")
            self.assertEqual(record["prompt"], "A calm harbour theme at dusk.")


if __name__ == "__main__":
    unittest.main()
