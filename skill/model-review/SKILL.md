---
name: model-review
description: Review 3D models (GLB) with a person in a feedback loop. Serve the models on a web page where the person pins notes to spots on the model, attaches reference images and poses the moving parts; then read each note and its images, change the model, re-export it, and reply under the note saying what changed. Use when someone wants to review, check or give feedback on a 3D model, asks you to act on model review notes, mentions model-review, or wants a GLB looked at by other people.
---

# Model review

model-review is a review loop between a person and you over 3D models. The person opens a model in the browser, clicks a spot to pin a note, sets the area it covers, attaches reference images (pasted, dropped or picked), scrubs the model's moving parts to the pose that shows the problem, and saves. Each note keeps a snapshot of the view. Each model gets a verdict: approved, or needs changes. You read the notes, fix the model, and reply under each note.

## Tools

Use the `model-review` MCP tools when they are available: `list_projects`, `create_project`, `open_project`, `get_project`, `add_model`, `update_model`, `serve`, `list_notes`, `get_note`, `reply`, `set_status`, `get_verdicts`, `wait_for_changes`, `export_artifact`.

Otherwise use the CLI, which does the same on a project folder: `model-review <command> <project folder>`. If `model-review` isn't on the PATH, run `node <repo>/bin/model-review.mjs`, where `<repo>` is two folders above this file's real location (resolve the skill's symlink: `readlink -f` on this file). `model-review --help` lists the commands. `show` prints a note with the absolute paths of its images: look at them with your file-reading tool.

## The loop

1. **Find or make the project.** `list_projects`. A project is a folder with `project.json`, its GLBs, and `review/` where notes live. New one: `create_project` (a folder and a title), then `add_model` for each GLB. `add_model` returns the GLB's node names: those name the parts (`parts`, labels for the parts a person may hide) and the parts an action moves.
2. **Serve it and give the person the URL.** `serve` starts the page on 127.0.0.1 (port 8795 or the next free one) if it isn't running. Tell them: click the model to pin a note, set its area, paste or drop reference photos, use the action slider to pose moving parts, save; mark notes fixed when they're happy; give each model a verdict.
3. **Wait for notes.** Either the person tells you they've left some, or call `wait_for_changes` (up to 300 s at a time, passing back the `cursor` it returns) to hear new notes, edits, replies and verdicts as they happen.
4. **Read every open note in full.** `list_notes` shows open ones (open = needs you; addressed = you replied last; resolved = fixed). `get_note` returns the note, where it is pinned, the pose and camera it was made in, its replies, and its reference images and view snapshot as images. Look at the images: they usually say more than the text. The snapshot shows the pinned area lit in amber on the model.
5. **Change the model.** Work in the model's source (a Blender file, a build script, whatever made the GLB), then re-export the GLB into the project. Overwrite the same file (`get_project` gives its absolute path) and every open page reloads it, keeping the person's camera and pose; or call `add_model` with `replace: true` for a file elsewhere. Keep node names the same: pins and actions are tied to them.
6. **Reply under each note you acted on.** Say concretely what changed: the part, the measurement, before and after ("Thinned the hasp plate from 3 mm to 1 mm and moved its hinge 2 mm up"). If you couldn't do it, or the note is unclear, say so and ask. Reply only after the new GLB is in place, so the person can check it at once.
7. **Leave resolving to the person.** They mark notes fixed or reply back (a reply from them makes the note open again). Don't call `set_status` with `resolved` unless they ask you to. Verdicts are theirs too.
8. Go back to step 3 until the models are approved.

## What a note's numbers mean

All coordinates are in the GLB's own frame: metres, glTF's y up, +z the model's front.

- `node`: the GLB node clicked (null for a note on the whole model). Its label, if any, comes from the model's `parts`.
- `local`: the spot in that node's own frame. It moves with the node, so it stays on a moving part.
- `world`: the spot in the model's frame with the model posed as it was when pinned.
- `radius`: the area the note covers, a sphere about the spot, in metres.
- `k`: the action's pose when pinned, 0 at rest to 1 fully worked. `get_note` says it in words (which parts had moved how far).
- `hidden`: parts the person had hidden to see inside.
- `view`: the camera position and target, model frame.

## Actions: the model's moving parts

A model's `action` in project.json lets the person scrub its moving parts. Set it with `update_model` (it is checked against the GLB's nodes):

```json
{ "name": "Open the case",
  "states": [{ "at": 0, "text": "Shut" }, { "at": 0.01, "text": "Opening" }, { "at": 1, "text": "Open" }],
  "steps": [
    { "type": "turn", "part": "hasp", "axis": [-1, 0, 0], "pivot": [0, 0.128, 0.105], "angle": 2.8, "to": 0.15 },
    { "type": "linkage", "crank": "lid", "coupler": "stay", "slider": "shoe", "pivot": [0.131, 0.12, -0.1], "knee": [0.131, 0.112, -0.05], "pin": [0.131, 0.112, 0.05], "line": [0, 0, 1], "axis": [-1, 0, 0], "angle": 1.75, "from": 0.15, "to": 0.75 },
    { "type": "move", "part": "drawer", "by": [0, 0, 0.13], "from": 0.6 },
    { "type": "hide", "part": "seal", "at": 0.1 }
  ] }
```

Each step runs over k from `from` to `to` (default 0 to 1), eased unless `"ease": "linear"`. Coordinates are the model's frame with every part at rest; angles are radians, right-handed about the axis. A part's steps compose in order, each riding on the ones before. A child node rides with its parent. `linkage` is a slider-crank, solved exactly: the crank turns about the pivot, the coupler joins knee to pin, the slider moves along `line` so the pin stays on it. `"clip": "<name>"` scrubs a glTF animation in the GLB instead.

## claude.ai Artifact mode

`export_artifact` builds the same page for publishing as a claude.ai Artifact, for reviewers on claude.ai. Publish it with the Artifact tool using the arguments it returns (`file_path`, `files`, `capabilities`, `icon`). There, notes live in the artifact's database (collection `notes`, verdicts in `verdicts`) and images in its assets:

- Read notes with ArtifactData `list` on `notes`; read an image with the Artifact tool's `read` and `path` set to the image id.
- Reply in place with ArtifactData `update` on `notes/<id>`: send the whole `replies` array with yours appended (`{ "by": "agent", "name": "Claude", "text": "…", "at": "<ISO time>" }`), plus `updated` (the same time) and `version` + 1, pinned with `if_version`.
- Or bring them home: ArtifactData `list` with `out_dir` on `notes` and `verdicts`, save the images with the Artifact tool's `read` (`paths`), then `model-review import-artifact <project> --from <out_dir> --images <folder>`.
