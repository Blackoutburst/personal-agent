# Companion character handbook

This kit is for Claude or Codex (or you) to make a new drawn character for the companion app: a picture set with
expressions and outfits that works in the web app and the Android app like Claude-chan, Astra, Gemini and DeepSeek.

Hand this whole folder to your agent and say which character you want. Everything it needs is here.

## What you are making

44 pictures of one character, all **edits of one base picture** (same canvas, framing, pose and head position):

| Group | Files | How the app uses them |
| --- | --- | --- |
| Base | `base.png` | The resting face and signature outfit. Everything else is an edit of it. |
| App faces (6) | `blink`, `talk`, `listening`, `thinking`, `happy`, `sleepy` (`.png`, next to base) | Shown as the companion blinks, writes, listens, thinks, is happy or sleepy. |
| Feelings (15) | `expr/laugh`, `wink`, `surprised`, `sad`, `worried`, `teary-smile`, `embarrassed`, `pout`, `proud`, `excited`, `confused`, `determined`, `tender`, `love`, `focused` | The companion picks one for a reply. |
| Outfits (22) | `outfit/cozy-home`, `pajamas`, `rain`, `sunny`, `snow`, `windy`, `spring`, `summer`, `autumn`, `winter`, `halloween`, `christmas`, `new-year`, `lunar-new-year`, `valentine`, `easter`, `summer-festival`, `birthday`, `party` (plus `base`) | Worn automatically by time of day, weather, season and special days, or picked by the owner. |

The app never stores "face × outfit" pictures. It cuts each face down to a **patch** (eyes, brows, cheeks, mouth) and
draws it over whichever outfit is worn. Where an outfit puts something in front of the face (a hat brim, other bangs),
a **front layer** is drawn over the patch. That only works if every picture keeps the face exactly where `base.png` has it.
That is why every prompt insists on "identical except…".

See `refs/example-characters.png`, `refs/example-faces.png` and `refs/example-outfits.png` for finished ones.

## What you need

- **An image generation tool that can edit an attached picture.** Codex has one built in (its image generation tool).
  Claude Code has no image generator of its own: it can drive the Codex CLI (`codex exec`, below) or any image API
  the person gives it. The prompts are written for an agent with such a tool.
- **Python 3 with Pillow and NumPy** for the tools (`pip install pillow numpy`).
- **A design reference** for the new character (optional but much better): a picture or character sheet you are
  allowed to use, saved as `design.png` in the character folder. Without one, describe the design in words.

## Steps

Work in a new folder per character, for example `work/nova/`. Commands run from the kit folder.

1. **Describe the character.** Copy `character.json` into the folder and fill it in:
   - `id`: lowercase letters only, unique (it becomes a folder name and a setting value).
   - `label`, `hint`: the name and short description shown in the character picker.
   - `looks`, `signature`: how the companion is told it looks and what its base outfit is, written to it ("you").
   - `prompt`: the values the prompt templates need. `DESIGN` is the full visual description; `HEAD_TOP` lists what
     sticks up from the head; `HEAD_RULES` says what must never change on the head (horns, ears…). If there is no
     design picture, set `DESIGN_SOURCE` to an empty string.
2. **Fill the prompts:** `python3 tools/prompts.py work/nova` writes `prompt-1-base.txt` … `prompt-5-outfits-special.txt`.
3. **Make the base.** Attach `refs/framing-and-style.png` (and `design.png`) to prompt 1. Look at the result and redo
   it until it is right: one face, two eyes, two eyebrows, nothing cut off, flat no-outline style, transparent
   background, same framing as the reference. **Everything else copies this picture, so take time here.**
4. **App faces, then feelings.** Attach `base.png` to prompts 2 and 3. Feelings go into `expr/`.
5. **Outfits.** Attach `base.png` to prompts 4 and 5. They go into `outfit/`. Long lists can be split into smaller
   batches if the tool stops early.
6. **Green backgrounds.** If the tool could not make transparency and returned flat #00FF00 green:
   `python3 tools/transparent.py work/nova/*.png work/nova/expr/*.png work/nova/outfit/*.png`.
7. **Find the face:** `python3 tools/art.py face work/nova` writes `face.json` (eye and mouth positions, found from
   where the expressions differ from base). Run it once all faces exist; delete `face.json` to recompute.
8. **Check:** `python3 tools/art.py check work/nova`. Each outfit must be `ok`; `face drift` means its face moved or
   changed, so redo that outfit. The last number is haze (% of faint pixels around the character): above ~0.5
   means a soft halo, so redo it.
9. **Look at everything:** `python3 tools/art.py gallery work/nova "Nova"`, then open `work/nova/gallery/index.html`.
   Its "Faces over outfits" section shows what the app will draw. Look for leftover eyes, doubled eyebrows, hair
   poking through hats, and a face that does not line up with the outfit.
10. **Export:** `python3 tools/export.py work/nova export/` writes `export/nova/` with the 512px WebP pictures and
    `character.json`. Zip that folder and send it to whoever runs your companion server.

### Running Codex for an image step

The prompt goes on stdin and every reference is an `-i` (the flag takes several files, so the prompt can't be an argument):

    cd work/nova
    codex exec --skip-git-repo-check -c sandbox_mode='"workspace-write"' -i ../../refs/framing-and-style.png -i design.png - < prompt-1-base.txt
    codex exec --skip-git-repo-check -c sandbox_mode='"workspace-write"' -i base.png - < prompt-2-app-faces.txt

`workspace-write` lets Codex save the pictures into the folder. One image step can take several minutes.

Check the files were actually saved where the prompt says before moving on.

## Rules that keep the set working

- **Never change the base after edits exist.** If the base must change, make every other picture again.
- **Every edit keeps canvas size, framing, pose and head position.** A face patch from a moved head lands in the wrong
  place on every outfit.
- **Faces change only the face.** No hands, props or symbols outside the face.
- **Exactly two eyes and two eyebrows**, where the base has them, with nothing left of the base eyes.
- **Outfits keep the base face** (same eyes, brows and mouth) and change only clothes and listed accessories.
- **Hats sit above the eyebrows**, and hair never pokes through a hat, hood or headband.
- **Transparent background with no halo, glow, blur or shadow.** The app shows the character on its own colors.
- **Same style as the series:** flat cel shading, no outlines, few strokes, soft pastel shading, rosy blush,
  slightly large head. `refs/framing-and-style.png` is the reference.
- **Use designs you have the right to use.** Don't recreate a copyrighted character or a real person.

## Adding it to the app (whoever runs the server)

From the exported folder `<id>/` (`faces/`, `outfits/`, `fronts/`, `character.json`), in the personal-agent repo:

1. Copy `faces/`, `outfits/` and `fronts/` into `public/characters/<id>/` and `android/app/src/main/assets/characters/<id>/`.
2. Register the id:
   - `server.mjs`: `PORTRAIT_CHARACTERS` (makes the pictures servable).
   - `src/companion.mjs`: `CHARACTERS`, `LOOKS[<id>]` (= `looks`) and `DRAWN`.
   - `src/wardrobe.mjs`: `SIGNATURE[<id>]` (= `signature`).
   - `public/companion-character.mjs`: the character list (`label`, `hint`) and `PORTRAITS`.
   - `android/.../Character.kt`: `CharacterInfo(<id>, label, hint)` and `PORTRAITS`.
   - `test/companion.test.mjs`: the list of drawn characters whose assets must exist.
3. Run the tests, bump the Android version, deploy, and publish the new APK.
