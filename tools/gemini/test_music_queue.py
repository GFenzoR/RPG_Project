"""The queue's rules against a fake Gemini: what is spent, when it sleeps, when it stops, which mode it asks in."""

from __future__ import annotations

import argparse
import datetime
import json
import os
import tempfile
import unittest

import music_queue as mq
import music_style
import page_rules as rules

NOW = datetime.datetime(2026, 11, 18, 10, 0, 0)
BOOK = {"house": "Calm, acoustic, loopable.", "variation": "Another take.",
        "slots": [{"id": "title", "text": "Main menu theme."}, {"id": "cave", "text": "Caverns."}]}


class FakeGemini:
    """Answers each ask with the next scripted outcome, writing the sidecar
    (and the track) music_web would."""

    def __init__(self, into, script):
        self.into = into
        self.script = list(script)
        self.asks = []
        self.fetches = []

    def ask(self, slot_id, number, text, modes):
        self.asks.append((slot_id, number, modes, text))
        outcome, extra = self.script.pop(0) if self.script else ("ok", {})
        record = {"kind": "music", "slot": slot_id, "prompt": text, "outcome": outcome,
                  "mode": extra.pop("mode", "Ayuda todos los días 4 Hydrogen"),
                  "started": NOW.isoformat(), "finished": (NOW - datetime.timedelta(hours=2)).isoformat()}
        record.update(extra)
        stem = os.path.join(self.into, "%s_%d" % (slot_id, number))
        with open(stem + ".json", "w", encoding="utf-8") as handle:
            json.dump(record, handle)
        if outcome == "ok":
            with open(stem + ".mp4", "wb") as handle:
                handle.write(b"\x00\x00\x00\x18ftypmp42")
            return rules.OK
        return {"quota": rules.QUOTA, "masked": rules.QUOTA, "not_sent": 1, "stalled": rules.STALLED,
                "policy": rules.POLICY, "timeout": rules.TIMEOUT}.get(outcome, rules.NOTHING)

    def fetch(self, slot_id, number, url):
        self.fetches.append((slot_id, number, url))
        return rules.TIMEOUT


class Run(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.into = self.folder.name
        self.slept = []
        self.said = []

    def tearDown(self):
        self.folder.cleanup()

    def queue(self, script, **overrides):
        args = argparse.Namespace(into=self.into, takes=1, retries=2, limit=0, wait=720.0, fetch_wait=120.0,
                                  max_sleep=6 * 3600.0, stall_cooldown=300.0, modes="")
        for key, value in overrides.items():
            setattr(args, key, value)
        self.gemini = FakeGemini(self.into, script)
        return mq.Queue(args, ask=self.gemini.ask, fetch=self.gemini.fetch, sleep=self.slept.append,
                        now=lambda: NOW, say=self.said.append)

    def test_a_slot_with_its_takes_is_not_asked_again(self):
        q = self.queue([("ok", {}), ("ok", {})])
        q.run(BOOK["slots"], BOOK)
        q.run(BOOK["slots"], BOOK)
        self.assertEqual([a[0] for a in self.gemini.asks], ["title", "cave"])

    def test_a_second_take_is_asked_as_a_variation(self):
        q = self.queue([("ok", {}), ("ok", {})], takes=2)
        q.run(BOOK["slots"][:1], BOOK)
        self.assertNotIn("Another take.", self.gemini.asks[0][3])
        self.assertIn("Another take.", self.gemini.asks[1][3])

    def test_refusals_are_spent_and_bounded_by_the_retries(self):
        q = self.queue([("policy", {})] * 5)
        q.run(BOOK["slots"][:1], BOOK)
        self.assertEqual(len(self.gemini.asks), 3)  # one take and two retries

    def test_a_masked_wall_in_hydrogen_moves_to_argon_without_sleeping(self):
        q = self.queue([("masked", {"mode": "Ayuda todos los días 4 Hydrogen"}), ("ok", {"mode": "Código y análisis 4 Argon"})])
        q.run(BOOK["slots"][:1], BOOK)
        self.assertEqual([a[2] for a in self.gemini.asks], [("Hydrogen", "Argon"), ("Argon",)])
        self.assertEqual(self.slept, [])

    def test_a_masked_wall_in_the_last_mode_sleeps_once_by_the_window_then_stops(self):
        q = self.queue([("masked", {"mode": "4 Argon"}), ("masked", {"mode": "4 Argon"})], modes="Argon")
        q.run(BOOK["slots"][:1], BOOK)
        # No track in the window: nothing to sleep to, so it stops at once.
        self.assertEqual(len(self.gemini.asks), 1)
        self.assertTrue(any("states no hour" in line for line in self.said))

    def test_a_stated_reset_is_slept_to_and_never_hammered(self):
        q = self.queue([("quota", {"reset": "2026-11-18T12:00"}), ("ok", {})])
        q.run(BOOK["slots"][:1], BOOK)
        self.assertEqual(self.slept, [2 * 3600.0 + 60.0])
        self.assertEqual(len(self.gemini.asks), 2)

    def test_a_reset_past_the_max_sleep_stops_the_run(self):
        q = self.queue([("quota", {"reset": "2026-11-19T12:00"})], max_sleep=3600.0)
        q.run(BOOK["slots"], BOOK)
        self.assertEqual(self.slept, [])
        self.assertEqual(len(self.gemini.asks), 1)

    def test_two_unsent_asks_stop_the_run_and_spend_nothing(self):
        q = self.queue([("not_sent", {}), ("not_sent", {}), ("ok", {})])
        q.run(BOOK["slots"], BOOK)
        self.assertEqual(len(self.gemini.asks), 2)
        self.assertEqual(mq.spent_of(mq.asks_of(self.into, "title")), [])

    def test_a_stall_cools_down_before_the_next_ask_and_is_free(self):
        q = self.queue([("stalled", {"url": "https://gemini.google.com/app"}), ("ok", {})])
        q.run(BOOK["slots"][:1], BOOK)
        self.assertEqual(self.slept, [300.0])
        self.assertEqual(mq.spent_of(mq.asks_of(self.into, "title")), [2])

    def test_stalls_past_the_free_ones_are_spent(self):
        asks = {n: {"sidecar": {"outcome": "stalled"}, "track": ""} for n in (1, 2, 3)}
        self.assertEqual(mq.spent_of(asks), [3])

    def test_a_timeout_with_no_conversation_is_a_stall(self):
        self.assertEqual(mq.outcome_of({"outcome": "timeout", "url": "https://gemini.google.com/app"}), "stalled")
        self.assertEqual(mq.outcome_of({"outcome": "timeout", "url": "https://gemini.google.com/app/abcdef12"}), "timeout")

    def test_a_track_still_generating_is_fetched_not_asked_again(self):
        q = self.queue([("timeout", {"url": "https://gemini.google.com/app/abcdef1234"})])
        q.run(BOOK["slots"][:1], BOOK)
        self.assertEqual(len(self.gemini.asks), 1)
        self.assertEqual(self.gemini.fetches, [("title", 1, "https://gemini.google.com/app/abcdef1234")])

    def test_the_window_paces_the_asks(self):
        for n in range(mq.WINDOW_TRACKS):
            with open(os.path.join(self.into, "old_%d.json" % n), "w", encoding="utf-8") as handle:
                json.dump({"kind": "music", "outcome": "ok",
                           "finished": (NOW - datetime.timedelta(minutes=50 - n)).isoformat()}, handle)
        self.assertEqual(mq.window_reopens(self.into, NOW), (NOW + datetime.timedelta(minutes=10)).isoformat())
        q = self.queue([("ok", {})])
        q.run(BOOK["slots"][:1], BOOK)
        self.assertEqual(self.slept, [600.0 + 60.0])

    def test_the_real_slots_build_their_prompts(self):
        book = music_style.load()
        self.assertEqual(len({slot["id"] for slot in book["slots"]}), len(book["slots"]))
        for slot in book["slots"]:
            self.assertIn(book["house"], music_style.prompt(book, slot, 1))


if __name__ == "__main__":
    unittest.main()
