"""What the drivers read off the page, the prompt rule, the lock and the credit record: no browser."""

from __future__ import annotations

import datetime
import os
import subprocess
import sys
import tempfile
import unittest

import browser_lock
import credit
import gemini_web
import music_style
import page_rules as rules
import prompt_guard

MENU = [
    {"said": "Ayuda todos los días 4 Hydrogen", "off": False},
    {"said": "Código y análisis 4 Argon", "off": False},
    {"said": "3.5 Flash-Lite", "off": False},
]


class TheReplies(unittest.TestCase):
    def test_the_text_model_sentence_is_masked(self):
        self.assertEqual(rules.classify("Lo que me pides está fuera de mis capacidades programadas. Solo genero texto."), "masked")
        self.assertEqual(rules.classify("No me han programado para hacer algo así."), "masked")

    def test_the_tool_out_of_service_of_2026_11_17_is_masked(self):
        said = "I'm unable to generate audio directly right now, as the audio generation tool isn't available."
        self.assertEqual(rules.classify(said), "masked")

    def test_a_stated_limit_is_the_quota_and_a_beta_refusal_is_policy(self):
        self.assertEqual(rules.classify("Has alcanzado el límite. Vuelve a intentarlo a las 14:30."), "quota")
        self.assertEqual(rules.classify("¡Vaya, parece que he tocado una nota discordante!"), "policy")
        self.assertEqual(rules.classify("Hubo un problema técnico y no pude generar la música."), "error")
        self.assertEqual(rules.classify("Here is a sheet of wolves."), "nothing")

    def test_the_reset_hour_is_read_and_a_past_hour_is_tomorrow(self):
        now = datetime.datetime(2026, 11, 17, 16, 0)
        self.assertEqual(rules.reset_of("vuelve a intentarlo a las 14:30", now), "2026-11-18T14:30")
        self.assertEqual(rules.reset_of("try again at 6:15 PM", now), "2026-11-17T18:15")
        self.assertEqual(rules.reset_of("en 3 horas", now), "2026-11-17T19:00")
        self.assertEqual(rules.reset_of("4 Hydrogen El límite se restablece el 18 nov, 11:53 p.m.", now), "2026-11-18T23:53")
        self.assertEqual(rules.reset_of("Your limit resets Nov 18, 9:05 AM", now), "2026-11-18T09:05")
        self.assertEqual(rules.reset_of("se restablece el 2 ene, 1:00 a.m.", now), "2027-01-02T01:00")
        self.assertEqual(rules.reset_of("sin hora", now), "")

    def test_codes(self):
        self.assertEqual(rules.fail_code("masked"), rules.QUOTA)
        self.assertEqual(rules.fail_code("stalled"), rules.STALLED)
        self.assertEqual(rules.fail_code("gone"), rules.NOTHING)


class TheModes(unittest.TestCase):
    def test_the_defaults_are_hydrogen_then_argon_and_can_be_replaced(self):
        self.assertEqual(rules.DEFAULT_MODES, ("Hydrogen", "Argon"))
        self.assertEqual(rules.modes_from(" Argon , Hydrogen "), ("Argon", "Hydrogen"))
        self.assertEqual(rules.modes_from(""), rules.DEFAULT_MODES)
        old = os.environ.get("GEMINI_MODES")
        os.environ["GEMINI_MODES"] = "Neon"
        try:
            self.assertEqual(rules.configured_modes(None), ("Neon",))
            self.assertEqual(rules.configured_modes("Argon"), ("Argon",))
        finally:
            if old is None:
                del os.environ["GEMINI_MODES"]
            else:
                os.environ["GEMINI_MODES"] = old

    def test_the_best_open_mode_is_picked_and_never_a_lite(self):
        self.assertEqual(rules.pick_mode(MENU, rules.DEFAULT_MODES), ("pick", "Ayuda todos los días 4 Hydrogen"))
        greyed = [dict(MENU[0], off=True), MENU[1], MENU[2]]
        self.assertEqual(rules.pick_mode(greyed, rules.DEFAULT_MODES), ("pick", "Código y análisis 4 Argon"))
        self.assertEqual(rules.pick_mode(MENU, ("Flash",)), ("none", ""))
        self.assertTrue(rules.is_lite("3.5 Flash-Lite"))

    def test_every_mode_spent_is_a_wall_with_its_hour(self):
        walled = [
            {"said": "Ayuda todos los días 4 Hydrogen El límite se restablece el 18 nov, 9:10 a.m.", "off": True},
            {"said": "Código y análisis 4 Argon El límite se restablece el 18 nov, 9:10 a.m.", "off": True},
            MENU[2],
        ]
        verdict, reset = rules.pick_mode(walled, rules.DEFAULT_MODES)
        self.assertEqual(verdict, "wall")
        self.assertTrue(reset.endswith("T09:10"))

    def test_the_menu_item_of_a_mode(self):
        labels = [item["said"] for item in MENU]
        self.assertEqual(rules.menu_index(labels, "Código y análisis 4 Argon"), 1)
        self.assertEqual(rules.menu_index(labels, "4 Hydrogen"), 0)
        self.assertEqual(rules.menu_index(labels, "Lite"), -1)

    def test_a_masked_wall_moves_to_the_next_mode_and_the_last_is_the_quota(self):
        self.assertEqual(rules.next_modes({"outcome": "masked", "mode": "4 Hydrogen"}, rules.DEFAULT_MODES), ("Argon",))
        self.assertIsNone(rules.next_modes({"outcome": "masked", "mode": "4 Argon"}, rules.DEFAULT_MODES))
        self.assertIsNone(rules.next_modes({"outcome": "quota", "mode": "4 Hydrogen"}, rules.DEFAULT_MODES))
        self.assertIsNone(rules.next_modes({"outcome": "masked", "mode": ""}, rules.DEFAULT_MODES))


class TheComposer(unittest.TestCase):
    def test_breaks_spaces_and_zero_width_marks_fold_away(self):
        self.assertEqual(rules.composed("a​  b\n\nc d"), "a b c d")

    def test_a_conversation_is_told_from_a_fresh_chat(self):
        self.assertTrue(rules.is_conversation("https://gemini.google.com/app/1a2b3c4d5e"))
        self.assertFalse(rules.is_conversation("https://gemini.google.com/app?hl=es_419"))


class ThePromptRule(unittest.TestCase):
    def test_our_own_prompts_pass(self):
        book = music_style.load()
        for slot in book["slots"]:
            for take in (1, 2):
                self.assertTrue(music_style.prompt(book, slot, take))
        self.assertEqual(prompt_guard.problems(gemini_web.HOUSE_RULES), [])

    def test_an_imitation_or_a_name_is_refused(self):
        for bad in (
            "music in the style of a famous game",
            "música al estilo de una saga conocida",
            "inspirada en la banda sonora de Diablo II",
            "a town like in Tibia",
            "something Matt Uelmen would write",
        ):
            self.assertTrue(prompt_guard.problems(bad), bad)
        with self.assertRaises(SystemExit):
            prompt_guard.check("sprites inspired by an old MMORPG")

    def test_ordinary_words_that_are_also_names_pass(self):
        for good in ("agua tibia y luz de vela", "un diablo de ceniza con alas", "la última nota se sostiene"):
            self.assertEqual(prompt_guard.problems(good), [], good)

    def test_a_sensitive_word_or_a_long_prompt_is_refused(self):
        book = {"house": "Calm.", "slots": []}
        with self.assertRaises(ValueError):
            music_style.prompt(book, {"id": "x", "text": "a bloodbath"})
        with self.assertRaises(ValueError):
            music_style.prompt(book, {"id": "x", "text": "a" * (music_style.MAX_PROMPT + 1)})
        self.assertTrue(music_style.prompt(book, {"id": "x", "text": "skilled hands on a lute"}))


class TheLock(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.folder.name, "browser.lock")

    def tearDown(self):
        self.folder.cleanup()

    def test_taken_held_and_dropped(self):
        self.assertTrue(browser_lock.take(path=self.path, say=lambda _line: None))
        self.assertEqual(browser_lock.holder(self.path)["pid"], os.getpid())
        browser_lock.drop(self.path)
        self.assertFalse(os.path.exists(self.path))

    def test_a_live_holder_keeps_it(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            with open(self.path, "w", encoding="utf-8") as handle:
                handle.write('{"pid": %d}' % child.pid)
            self.assertFalse(browser_lock.take(wait=0.0, path=self.path, say=lambda _line: None))
        finally:
            child.kill()
            child.wait()

    def test_a_lock_left_by_a_dead_driver_is_taken_over(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write('{"pid": %d}' % child.pid)
        self.assertTrue(browser_lock.take(wait=0.0, path=self.path, say=lambda _line: None))
        browser_lock.drop(self.path)

    def test_it_is_the_one_ants_of_neque_takes(self):
        self.assertTrue(browser_lock.LOCK.endswith("ants_of_neque_gemini_browser.lock"))


class TheCredit(unittest.TestCase):
    def test_the_prompt_file_mirrors_the_asset(self):
        self.assertEqual(credit.prompt_path("assets/sounds/music/title.ogg"), "assets/prompts/sounds/music/title.txt")
        self.assertEqual(credit.prompt_path("assets\\sprites\\creatures\\wolf.png"), "assets/prompts/sprites/creatures/wolf.txt")
        with self.assertRaises(SystemExit):
            credit.prompt_path("build/gemini/music/title_1.mp4")

    def test_the_prompt_comes_from_the_ask_or_its_delivery(self):
        self.assertEqual(credit.delivery_of({"delivery": {"prompt": "p"}})["prompt"], "p")
        with self.assertRaises(SystemExit):
            credit.delivery_of({"source": "x.mp4"})

    def test_the_row_and_the_file_say_tool_date_and_prompt(self):
        ask = {"prompt": "Harbour town theme.", "started": "2026-11-17T23:05:17", "mode": "4 Hydrogen", "tool": "music_web.py"}
        row = credit.credits_row(ask, ["assets/sounds/music/puerto.ogg"], "assets/prompts/sounds/music/puerto.txt")
        self.assertEqual(
            row,
            "| `assets/sounds/music/puerto.ogg` | Gemini, app web con la cuenta del dueño (modo 4 Hydrogen) | 2026-11-17 "
            "| `assets/prompts/sounds/music/puerto.txt` | — |",
        )
        text = credit.prompt_text(ask, ["assets/sounds/music/puerto.ogg"])
        self.assertTrue(text.endswith("\n\nHarbour town theme.\n"))
        self.assertIn("# Fecha: 2026-11-17", text)


class TheNames(unittest.TestCase):
    def test_an_output_name_is_a_safe_file_name(self):
        self.assertEqual(gemini_web.slug("Wolf Walk/../x"), "wolf_walk_x")
        with self.assertRaises(SystemExit):
            gemini_web.slug("../")


if __name__ == "__main__":
    unittest.main()
