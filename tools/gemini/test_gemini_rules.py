"""What the drivers read off the page, the prompt rule, the lock and the credit record: no browser."""

from __future__ import annotations

import datetime
import hashlib
import os
import subprocess
import sys
import tempfile
import types
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


class MenuPage:
    """A page whose composer is in no mode of the list and whose mode menu
    holds `items`: what `ensure_mode` reads."""

    def __init__(self, items):
        self.items = items
        self.keyboard = types.SimpleNamespace(press=lambda key: None)

    def evaluate(self, script, arg=None):
        if script == gemini_web.STATE_JS:
            return {"media": [], "labels": [], "text": "", "replies": 0, "asked": 0, "music_elements": 0,
                    "mode": "", "composer": 0}
        return [dict(item) for item in self.items]

    def locator(self, _selector):
        return types.SimpleNamespace(first=types.SimpleNamespace(click=lambda: None), all=lambda: [])

    def wait_for_timeout(self, _ms):
        pass


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

    def test_a_brief_that_says_limited_or_resets_is_not_the_quota(self):
        # Gemini describes the track it is making; "limited" held "limite".
        for brief in (
            "Here is a calm harbour theme with a limited palette.",
            "Slow strings, limited instrumentation, a long fade.",
            "The track resets the mood after the bridge.",
            "Un tema tranquilo con percusión limitada.",
        ):
            self.assertEqual(rules.classify(brief), "nothing", brief)
        self.assertEqual(rules.classify("Has alcanzado tu límite de hoy."), "quota")
        self.assertEqual(rules.classify("Llegaste a los límites de uso."), "quota")
        self.assertEqual(rules.classify("You've hit your limit for now."), "quota")

    def test_only_a_refusal_that_cannot_be_a_brief_ends_a_busy_wait(self):
        self.assertTrue(rules.ends_wait("policy", "¡Vaya, una nota discordante!"))
        self.assertTrue(rules.ends_wait("error", "Algo salió mal."))
        self.assertTrue(rules.ends_wait("quota", "El límite se restablece a las 14:30."))
        self.assertTrue(rules.ends_wait("quota", "Has alcanzado el límite. Vuelve más tarde."))
        self.assertTrue(rules.ends_wait("quota", "You've reached your music limit for today."))
        # A brief can say "limit" or "quota" in passing: never while the page works.
        self.assertFalse(rules.ends_wait("quota", "A theme with no limit to its quiet."))
        self.assertFalse(rules.ends_wait("quota", "Each voice keeps its quota of the melody."))
        self.assertFalse(rules.ends_wait("masked", "Solo genero texto."))
        self.assertFalse(rules.ends_wait("nothing", "Generando tu pista"))

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

    def test_greyed_modes_that_state_no_hour_are_a_wall_without_one(self):
        greyed = [dict(MENU[0], off=True), dict(MENU[1], off=True), MENU[2]]
        self.assertEqual(rules.pick_mode(greyed, rules.DEFAULT_MODES), ("wall", ""))
        self.assertEqual(rules.pick_mode([], rules.DEFAULT_MODES), ("none", ""))

    def test_a_menu_with_none_of_the_modes_is_the_page_not_the_quota(self):
        with self.assertRaises(gemini_web.NotSent) as said:
            gemini_web.ensure_mode(MenuPage([]), rules.DEFAULT_MODES)
        self.assertIn("has the page changed", str(said.exception))
        with self.assertRaises(gemini_web.NotSent):
            gemini_web.ensure_mode(MenuPage([{"said": "Modelo Nuevo", "off": False}]), rules.DEFAULT_MODES)
        greyed = [dict(MENU[0], off=True), dict(MENU[1], off=True), MENU[2]]
        with self.assertRaises(gemini_web.ModeWall) as wall:
            gemini_web.ensure_mode(MenuPage(greyed), rules.DEFAULT_MODES)
        self.assertEqual(wall.exception.reset, "")

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

    def test_the_house_rules_keep_every_hue_the_key_takes_out_of_a_subject(self):
        # import_art keys by hue (red and blue above green): violets go too.
        for hue in ("magenta", "pink", "purple", "violet"):
            self.assertIn(hue, gemini_web.HOUSE_RULES)

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

    def test_the_conversation_address_is_never_committed(self):
        ask = {"prompt": "Harbour theme.", "started": "2026-11-17T23:05:17",
               "url": "https://gemini.google.com/app/1a2b3c4d5e6f"}
        self.assertNotIn("gemini.google.com", credit.prompt_text(ask, ["assets/sounds/music/puerto.ogg"]))
        self.assertNotIn("gemini.google.com", credit.credits_row(ask, ["assets/sounds/music/puerto.ogg"], "p.txt"))

    def test_the_references_go_into_the_prompt_file_and_the_row(self):
        ref = prompt_guard.ref_record(os.path.join(prompt_guard.ROOT, "assets", "CREDITS.md"))
        ask = {"prompt": "A wolf facing west.", "started": "2026-11-18T10:00:00", "refs": [ref]}
        self.assertEqual(credit.refs_of(ask), [ref])
        text = credit.prompt_text(ask, ["assets/sprites/creatures/wolf/walk_w_0.png"])
        self.assertIn("# Referencia: assets/CREDITS.md (sha256 %s)" % ref["sha256"], text)
        row = credit.credits_row(ask, ["assets/sprites/creatures/wolf/walk_w_0.png"], "p.txt", "frames 0-3")
        self.assertTrue(row.endswith("| Referencias: `assets/CREDITS.md`. frames 0-3 |"), row)

    def test_a_reference_that_is_not_a_repo_asset_is_never_credited(self):
        real = os.path.join(prompt_guard.ROOT, "assets", "CREDITS.md")
        with open(real, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        for ref in (
            {"file": "wolf.png", "sha256": digest},  # the old sidecars: a bare name
            {"file": "assets/no/such/sprite.png", "sha256": digest},
            {"file": "assets/../tools/gemini/credit.py", "sha256": digest},
            {"file": "assets/CREDITS.md", "sha256": "0" * 64},  # not the file that was sent
            {"file": "assets/CREDITS.md"},  # no digest: nothing shows it is the file that was sent
            "assets/CREDITS.md",
        ):
            with self.assertRaises(SystemExit, msg=repr(ref)):
                credit.refs_of({"prompt": "p", "refs": [ref]})

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


class TheReferences(unittest.TestCase):
    def test_a_committed_asset_may_be_sent_and_is_recorded_by_path_and_digest(self):
        path = os.path.join(prompt_guard.ROOT, "assets", "CREDITS.md")
        got = prompt_guard.ref_record(path)
        self.assertEqual(got["file"], "assets/CREDITS.md")
        with open(path, "rb") as handle:
            self.assertEqual(got["sha256"], hashlib.sha256(handle.read()).hexdigest())

    def test_a_file_outside_the_repos_assets_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            outside = os.path.join(folder, "someone_elses_sprite.png")
            with open(outside, "wb") as handle:
                handle.write(b"\x89PNG")
            with self.assertRaises(SystemExit):
                prompt_guard.ref_record(outside)
        with self.assertRaises(SystemExit):
            prompt_guard.ref_record(os.path.join(prompt_guard.ROOT, "assets", "..", "tools", "gemini", "credit.py"))
        with self.assertRaises(SystemExit):
            prompt_guard.ref_record(os.path.join(prompt_guard.ROOT, "assets", "no_such_file.png"))

    def test_a_file_dropped_into_assets_but_never_committed_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            subprocess.run(["git", "init", "-q", root], check=True)
            os.makedirs(os.path.join(root, "assets"))
            path = os.path.join(root, "assets", "dropped.png")
            with open(path, "wb") as handle:
                handle.write(b"\x89PNG")
            self.assertIn("not committed", prompt_guard.ref_problem(path, root))
            subprocess.run(["git", "-C", root, "add", "assets/dropped.png"], check=True)
            self.assertEqual(prompt_guard.ref_problem(path, root), "")
            self.assertEqual(prompt_guard.ref_record(path, root)["file"], "assets/dropped.png")


class TheNames(unittest.TestCase):
    def test_an_output_name_is_a_safe_file_name(self):
        self.assertEqual(gemini_web.slug("Wolf Walk/../x"), "wolf_walk_x")
        with self.assertRaises(SystemExit):
            gemini_web.slug("../")


if __name__ == "__main__":
    unittest.main()
