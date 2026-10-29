# Voqal: functionality, usage, noise handling, speed, and speech accuracy

Research date: 19 October 2026.

This guide covers the **original Voqal project at voqal.dev and github.com/voqal**, as requested. It does not describe AbleSpeak or assume that AbleSpeak's safety, speech, and performance features exist in Voqal. It also does not use the similarly named voqal.ai SDK as evidence for this project.

The guide combines public documentation, release notes, and inspection of the public library on the `master` branch. It is a source-based guide, not a report of running Voqal on a real computer. Examples below are natural-language requests to try with the relevant integration enabled, not guaranteed fixed command phrases.

## Contents

1. [What Voqal does](#1-what-voqal-does)
2. [How a spoken request becomes an action](#2-how-a-spoken-request-becomes-an-action)
3. [Functionality by application](#3-functionality-by-application)
4. [Getting started and everyday use](#4-getting-started-and-everyday-use)
5. [How it handles noise](#5-how-it-handles-noise)
6. [How it interprets the right words](#6-how-it-interprets-the-right-words)
7. [How it reduces waiting](#7-how-it-reduces-waiting)
8. [Customization and privacy](#8-customization-and-privacy)
9. [Limits and practical verification](#9-limits-and-practical-verification)
10. [Public tool inventory](#10-public-tool-inventory)

## 1. What Voqal does

Voqal is a voice-driven AI assistant that uses natural-language requests to operate supported applications and services. Its public project highlights live context, editable prompts, and prompt routing. Instead of requiring one exact phrase for each operation, it combines a request with information about the application and chooses available tools. The actual scope depends on the installed integrations, enabled profiles, and configured models. [Project overview](https://github.com/voqal/voqal).

There are two generations to distinguish:

| Evidence | What it describes |
|---|---|
| Documentation quickstart | An earlier JetBrains plugin setup, recommending an older Gemini model. |
| GitHub 2.x preview releases | The later application, with changes to voice detection, Windows automation, model defaults, and performance reporting. |
| Public library | App profiles, context readers, and action scripts. A script's presence does not establish universal compatibility or that every profile enables it. |

Do not combine old setup instructions and newer defaults into one assumed configuration. The public release listing inspected includes `2.2.0-preview`; that is a preview release, not evidence of a production-readiness guarantee. [Quickstart](https://docs.voqal.dev/quickstart), [release history](https://github.com/voqal/voqal/releases).

## 2. How a spoken request becomes an action

```text
Microphone audio
    |
    v
Voice activity detection / configured activation
    |
    v
Speech recognition OR audio-capable model
    |
    +-- Current application, tab, document, or editor context
    +-- Selected profile's instructions and available tools
    |
    v
Model interprets intent and requests a tool
    |
    v
Integration executes the operation
    |
    v
Application changes / assistant responds
```

This is a conceptual flow, not a claim that every provider uses identical stages. Voqal's context system supplies the request and available tools to a model; the model selects the operations. Pebble templates assemble context. The configured provider can change how audio and text enter that process. [Context documentation](https://docs.voqal.dev/context/overview).

**Example: “Read that email.”** In the Gmail profile, the context identifies the inbox or open message. The prompt instructs the assistant to obtain the full thread through `read_email` before reading or summarizing it. This helps connect “that email” to an actual item rather than a guess from the spoken words alone. [Gmail profile](https://github.com/voqal/voqal/blob/master/library/gmail/gmail.md).

## 3. Functionality by application

### General assistance and desktop applications

The default profile includes answering questions, ignoring irrelevant input, and computer tools for opening, showing, and moving application windows. For example, a user could request “Open Notepad” or ask to bring an application forward. The launch tool calls the automation interface directly. These tools do not establish support for every control in every application. [Default profile](https://github.com/voqal/voqal/blob/master/library/voqal/voqal.md), [computer tools](https://github.com/voqal/voqal/tree/master/library/computer/tools).

### Chrome and Brave

The Chrome profile activates when its integration is connected and a matching browser process is active. It includes browser tools to create a tab, activate a tab, and open a URL, plus general tools. Example requests include “Open a new tab” and “Open this website.” Website-specific profiles add richer operations. [Chrome profile](https://github.com/voqal/voqal/blob/master/library/chrome/chrome.md), [Chrome integration](https://github.com/voqal/chrome-integration).

### Gmail in the browser

The Gmail profile reads inbox information, selected messages, sender information, and the displayed conversation. It can select messages, read a thread, mark selected messages, return to the inbox, and draft a reply.

Examples: “Read the first unread email,” “Summarize this conversation,” or “Draft a reply saying I can attend.” Its instructions prioritize unread messages for reading and prohibit unsolicited reply drafting. These are prompt instructions, not a universal confirmation mechanism. [Gmail profile and tools](https://github.com/voqal/voqal/tree/master/library/gmail).

### Gmail API

Separate service tools exist for adding a label and creating a draft. These require the service to be configured and authorized. Browser Gmail and Gmail API are separate action paths; enabling one does not prove the other is ready. The inspected API tool inventory does not include a dedicated send-email tool. [Gmail API tools](https://github.com/voqal/voqal/tree/master/library/gmail_api/tools).

### YouTube

The profile supplies playback position, duration, search results, and upcoming videos. Its tools cover search, opening a video, playback control, muting, seeking, and next/previous navigation.

Examples: “Search YouTube for guitar lessons,” “Open the video called …,” or “Go to two minutes.” Search and upcoming entries include video IDs, giving the model concrete targets. The profile also fetches SponsorBlock segment information with a five-minute cache hint; this provides information for interpreting a skip request, not proof of unconditional automatic sponsor skipping. [YouTube profile](https://github.com/voqal/voqal/blob/master/library/youtube/youtube.md), [YouTube tools](https://github.com/voqal/voqal/tree/master/library/youtube/tools).

### Notepad on Windows

Voqal can read the current document into context and replace its text through Windows UI Automation. The prompt supports requests to append, prepend, replace, delete, or read text. “Add a shopping list at the end” is therefore an editing instruction, while a general question should receive an answer without changing the note.

The implementation tries both newer document controls and older edit boxes. It requires a writable Value pattern; unavailable or read-only controls can prevent changes. It sets document text rather than necessarily simulating typing character by character. [Notepad profile](https://github.com/voqal/voqal/blob/master/library/notepad/notepad.md), [text-setting implementation](https://github.com/voqal/voqal/blob/master/library/notepad/tools/set_text/set_text.kt).

### Visual Studio Code

Context readers expose the active editor, open files, project tree, project root, and workspace files. The idle profile enables file opening/closing, line navigation, and entry into edit mode. Edit mode uses the current text and follow-up instructions to refine proposed changes, with accept and cancel operations.

Examples: “Open the settings file,” “Go to line twenty,” “Refactor this function,” followed by “Use a clearer variable name.” The edit prompt supports full-text output and conditional partial-transcript handling. A `run_file` definition exists in the library, but it is not in the inspected idle profile's explicit tool list. The integration's README labels it alpha with limited command support. [Idle profile](https://github.com/voqal/voqal/blob/master/library/vscode/voqal-idle-mode.md), [edit profile](https://github.com/voqal/voqal/blob/master/library/vscode/voqal-edit-mode.md), [integration status](https://github.com/voqal/vscode-integration).

### Amazon

The public library contains an Amazon search tool and a search-results context reader. This supports describing Amazon search as a library capability, but does not establish a ready-to-use checkout or purchasing workflow. [Amazon library](https://github.com/voqal/voqal/tree/master/library/amazon).

## 4. Getting started and everyday use

### Setup sequence

1. Identify the Voqal build you intend to use: standalone preview or older IDE plugin.
2. Obtain that build through the project's official release or integration channel.
3. Configure a provider/model supported by that build and supply its required credentials. Old model names in examples are historical, not a guarantee that those services remain available.
4. Allow microphone access and select the intended input device where the build exposes that setting.
5. Install/connect the integration for the application you want to control.
6. Ensure the relevant profile is enabled and matches the active application or website.
7. Start with an observable, reversible request such as opening a tab or navigating to a line.
8. Check both what was understood and what actually changed before trying a longer task.

The older documented plugin route is JetBrains **Settings → Plugins → Marketplace → Voqal**, followed by **Settings → Tools → Voqal**. Use that only for the plugin generation. The quickstart's model recommendation and statement about not using wake words should not be treated as universal settings for later previews. [Historical quickstart](https://docs.voqal.dev/quickstart).

### A useful way to give requests

State the action and target together: “Open the email from Amina,” rather than “Open it” when several items are plausible. For text work, distinguish a question from an edit: “Explain this paragraph” versus “Replace this paragraph with …”. Give corrections that identify the mistaken target. These are practical usage suggestions, not special syntax required by Voqal.

## 5. How it handles noise

There are three separate problems: detecting speech, deciding whether it is addressed to the assistant, and recognizing its words. Solving one does not automatically solve the others.

| Mechanism | Evidence in Voqal | Practical limit |
|---|---|---|
| Voice activity detection (VAD) | Release `2.0.1-preview` changed the default from WebRTC to Silero. | Detects likely speech; does not identify the speaker or remove competing voices. |
| Wake-word configuration | Release `2.1.2-preview` records fixes for Picovoice wake-word settings. | Establishes a configuration feature, not its exact behavior in every build. |
| Non-command rejection | The default prompt instructs the model to disregard empty input, coughs, sneezes, and other non-command audio. | A model instruction can fail; it is not a hard acoustic filter. |
| Irrelevant-speech rejection | The VS Code idle prompt tells the model to ignore speech not intended for it. | Another person's command-like speech may still be misinterpreted. |
| Explicit ignore tool | `ignore` accepts the transcript and a reason for ignoring it. | It depends on the assistant choosing that tool correctly. |

[Release notes](https://github.com/voqal/voqal/releases), [default prompt](https://github.com/voqal/voqal/blob/master/library/voqal/voqal.md), [idle prompt](https://github.com/voqal/voqal/blob/master/library/vscode/voqal-idle-mode.md), [ignore definition](https://github.com/voqal/voqal/blob/master/library/voqal/tools/ignore/ignore.yaml).

**VAD is not noise cancellation.** It decides whether audio resembles speech. A television, another person, or the assistant's own loudspeaker output can also resemble speech. I did not verify a dedicated denoising pipeline, acoustic echo-cancellation implementation, speaker verification, or a measured noisy-room success rate in the inspected material. The VAD documentation pages themselves are marked under development. [Voqal VAD page](https://docs.voqal.dev/compute/vad/voqal), [Picovoice VAD page](https://docs.voqal.dev/compute/vad/picovoice).

Practical setup suggestions: keep the microphone consistently positioned, reduce competing playback, and test with the person's normal speaking volume. If a build exposes sensitivity or end-of-speech controls, adjust one at a time. Stricter detection may reject more noise but can also miss quiet or atypical speech; a shorter pause threshold can respond sooner but split an unfinished sentence. No verified Voqal-specific threshold values are prescribed here.

## 6. How it interprets the right words

Voqal cannot make sure every word is correct. Its strongest documented mechanism is using relevant context to interpret imperfect input.

### Speech recognition and intent are different

Speech recognition estimates what was said. Intent interpretation decides what operation the user meant. A correct transcript can still produce the wrong action, and an imperfect transcript can sometimes produce the right action. The VS Code idle prompt explicitly anticipates transcription errors and directs the model to use context and similar-sounding words. [Idle prompt](https://github.com/voqal/voqal/blob/master/library/vscode/voqal-idle-mode.md).

### Context narrows possible meanings

The same phrase can mean different things in different apps. “Next” might refer to a video in YouTube; “replace this” might refer to selected code or the open note. App and website selectors choose the relevant prompt, and context supplies actual file names, document text, email IDs, or video IDs. This is evidence-backed context selection; the resulting accuracy improvement is an engineering expectation, not a measured percentage. [Chrome profile](https://github.com/voqal/voqal/blob/master/library/chrome/chrome.md), [YouTube profile](https://github.com/voqal/voqal/blob/master/library/youtube/youtube.md), [Notepad profile](https://github.com/voqal/voqal/blob/master/library/notepad/notepad.md).

### Partial speech requires restraint

The VS Code edit template has a conditional streaming-transcript branch. It tells the model not to infer more than the partial instruction says and to revise earlier output when later words clarify it. This demonstrates intended handling of incomplete speech when that mode is enabled; it does not prove every deployment streams transcripts. [Edit prompt](https://github.com/voqal/voqal/blob/master/library/vscode/voqal-edit-mode.md).

### What is not established

The inspected sources do not establish per-user acoustic training, guaranteed recognition of speech impairments, verified accent-specific accuracy, a universal confidence threshold, or a mandatory repeat-back before every operation. Prompt customization is not equivalent to training the speech recognizer.

## 7. How it reduces waiting

Voqal contains mechanisms that can reduce delay, but the research did not establish that it is faster than AbleSpeak or another product under matched conditions.

| Mechanism | What the source shows | Why it can help — inference |
|---|---|---|
| Streaming responses | Multiple profiles set `streamCompletions: true`. | Output can become available before the entire response is complete. |
| App-specific tool selection | Profiles load relevant tools using selectors. | The model has fewer irrelevant actions to consider. |
| Fresh application context | Templates include current text, tabs, messages, or video results. | Fewer preliminary questions or discovery steps may be needed. |
| Structured tool calls | Profiles request native function calling where configured. | The integration receives an operation with parameters rather than prose to interpret. |
| Direct application operations | Notepad uses a UI Automation Value pattern; the launch tool calls automation. | A single application operation can replace many simulated keystrokes. |
| Cached external context | YouTube's SponsorBlock fetch supplies a cache duration. | Repeated requests may avoid an external fetch. |
| Different models per profile | Inspected idle and edit profiles name different model configurations. | A workflow can use a model suited to its task, although actual speed depends on configuration. |

[Default profile](https://github.com/voqal/voqal/blob/master/library/voqal/voqal.md), [Chrome profile](https://github.com/voqal/voqal/blob/master/library/chrome/chrome.md), [edit profile](https://github.com/voqal/voqal/blob/master/library/vscode/voqal-edit-mode.md), [Notepad implementation](https://github.com/voqal/voqal/blob/master/library/notepad/tools/set_text/set_text.kt), [YouTube profile](https://github.com/voqal/voqal/blob/master/library/youtube/youtube.md).

Release notes also record performance metrics on the home panel and a later default of `gpt-4o-realtime-preview`. These are historical configuration facts, not a current service-availability or latency promise. [Release history](https://github.com/voqal/voqal/releases).

A useful measurement model is:

```text
Time from finishing speech to completed action
  = speech-end detection delay
  + remaining recognition/model processing
  + context/tool communication
  + application execution time
```

Streaming may overlap some stages. Measure time to the actual application change separately from time to the first spoken reply. A quick acknowledgment does not prove the action finished. Do not assume Voqal has AbleSpeak's deterministic fast-command router: that was not verified in the original project's inspected sources.

## 8. Customization and privacy

Voqal's documented customization model allows changes to providers, prompts, and tools. The older project configuration workflow uses `.voqal/config.json`; the documentation says changes require a restart and that paths containing `.voqal` are excluded from the assistant's file visibility. Confirm applicability to the installed build before changing configuration. [Customization documentation](https://docs.voqal.dev/customization).

A profile generally combines:

- A selector identifying the application, integration, website, or mode.
- Prompt settings, such as model configuration and streaming behavior.
- A list of tools the assistant may choose.
- Instructions and templates that insert current application context.

For example, the Notepad prompt says to edit only when asked, while Gmail says not to draft unsolicited replies. These rules guide behavior; they should not be described as enforced authorization checks. [Notepad profile](https://github.com/voqal/voqal/blob/master/library/notepad/notepad.md), [Gmail profile](https://github.com/voqal/voqal/blob/master/library/gmail/gmail.md).

Voqal's privacy page states that voice interactions, code, and other supplied data go to the compute providers the user selects rather than to the Voqal authors. This is the project's stated policy, not an independent network audit. Choosing a cloud provider can still send audio or application context off the computer. Do not equate a local integration or local VAD with an entirely offline assistant. [Privacy documentation](https://docs.voqal.dev/privacy).

## 9. Limits and practical verification

### Important boundaries

- A public tool definition is evidence of an implementation, not proof that it succeeds on today's version of the target app.
- Some documentation is incomplete or describes an earlier generation.
- The VS Code integration declares alpha status.
- A prompt that says to ignore unrelated speech is not speaker authentication.
- No universal spoken-confirmation rule for sends, deletes, or closing unsaved work was verified here. AbleSpeak's confirmation fixes must not be attributed to Voqal.
- A model can mishear, misunderstand, choose the wrong target, or report success without the intended outcome. Inspect the outcome during evaluation.

### Suggested evaluation checklist

This is a proposed test procedure, not a claimed built-in feature:

| Test | What to record |
|---|---|
| Quiet-room requests | Transcript accuracy and whether the intended action completed. |
| Fan or traffic noise | Missed requests and unintended activations. |
| Nearby conversation | Whether speech from someone else triggers an action. |
| Video and assistant playback | Whether playback is treated as user input. |
| Quiet speech and natural pauses | Missing first/last words and premature splitting. |
| Names and similar-sounding words | Wrong file, contact, video, or application selection. |
| Switching applications | Whether the selected profile and target follow the actual active app. |
| Timing repeated requests | Median and slow-tail action latency, including cold starts. |
| Cancel and correction | Whether the operation stops and whether an unwanted action remains queued. |

Use harmless sample files and drafts for initial evaluation. The result to optimize is the correct intended action with little effort, not just a fast response or a plausible transcript.

## 10. Public tool inventory

The public `master` tree inspected on the research date contains these 32 tool definitions. This is a library inventory, not a promise that all are exposed by the default profiles.

| Library | Tool definitions |
|---|---|
| Default Voqal | `answer_question`, `ignore` |
| Computer | `open_application`, `show_application`, `move_application_window` |
| Chrome | `create_tab`, `make_tab_active`, `open_url` |
| Gmail browser | `back_to_inbox`, `draft_email_reply`, `mark_selected_emails`, `read_email`, `select_emails` |
| Gmail API | `add_label`, `make_draft` |
| Notepad | `set_text` |
| VS Code | `cancel`, `close_file`, `edit_text`, `goto_line`, `looks_good`, `open_file`, `run_file`, `toggle_edit_mode` |
| YouTube | `mute_video`, `next_video`, `open_video`, `play_video`, `previous_video`, `search`, `seek_video` |
| Amazon | `search_amazon` |

Context definitions additionally cover Amazon results; Gmail messages and user information; Notepad text; VS Code editor/workspace state; and YouTube playback, search results, and upcoming videos. [Public library tree](https://github.com/voqal/voqal/tree/master/library), [repository tree API used for the inventory](https://api.github.com/repos/voqal/voqal/git/trees/master?recursive=1).

For further reading, start with the [official documentation index](https://docs.voqal.dev/llms.txt) and [release notes](https://github.com/voqal/voqal/releases). Treat statements in this guide as bounded by the cited source and research date; no runtime benchmark or user trial was performed for this document.
