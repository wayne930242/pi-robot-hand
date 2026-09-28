/**
 * pi-robot-hand: the agent hands the user a command. After the user agrees, it lands in the pi
 * prompt (shell commands as `! command`) or the clipboard. The user decides whether to run it;
 * the agent never does.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Choice, dialogTitle, options, promptText, resultText, toOffer } from "./hand.ts";

interface HandDetails {
	command: string;
	status: "waiting" | Choice;
}

const Params = Type.Object({
	command: Type.String({
		description: "The command to hand over. kind=shell: a shell command without a leading `!`. kind=pi: a pi slash command such as `/reload`.",
	}),
	reason: Type.String({ description: "One short line telling the user why they should run it, in the user's language." }),
	kind: Type.Optional(
		StringEnum(["shell", "pi"] as const, {
			description:
				"shell: goes to the prompt as `! command` (output returns to the conversation) or to the clipboard for another terminal. pi: a pi slash command, placed in the prompt as-is. Default shell.",
		}),
	),
});

export function createRobotHand(copy: (text: string) => Promise<void> = copyToClipboard) {
	return function robotHand(pi: ExtensionAPI) {
		pi.registerTool({
			name: "robot_hand",
			label: "Robot Hand",
			description:
				"Hand the user a command to run themselves. The user sees the command and the reason, then puts it in their pi prompt (a shell command becomes `! command`, whose output returns to the conversation when they press Enter), copies it to the clipboard, or declines. The tool returns the user's choice; it never runs the command.",
			promptSnippet: "Hand the user a command to run themselves, via their pi prompt or clipboard",
			promptGuidelines: [
				"Use robot_hand when the user has to run a command themselves: pi slash commands such as /reload, interactive or sudo commands, commands a guard blocked, or anything they asked to run on their own.",
				"Pass one command per robot_hand call and write the reason in the user's language.",
				"After robot_hand places or copies a command, nothing has run yet: wait for the user instead of assuming the result.",
			],
			parameters: Params,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!ctx.hasUI) {
					throw new Error("robot_hand needs an interactive pi UI; show the command to the user in chat instead.");
				}
				const offer = toOffer(params.command, params.kind);
				const text = promptText(offer);
				const choices = options(offer, ctx.ui.getEditorText().trim().length > 0, ctx.mode === "tui");

				onUpdate?.({ content: [{ type: "text", text: "Waiting for the user to take the command..." }], details: { command: text, status: "waiting" } });
				pi.events.emit("herdr:blocked", { active: true, label: "Waiting for the user to take a command" });
				let picked: string | undefined;
				try {
					picked = await ctx.ui.select(
						dialogTitle(offer, params.reason),
						choices.map((option) => option.label),
						{ signal },
					);
				} finally {
					pi.events.emit("herdr:blocked", { active: false });
				}
				const choice = choices.find((option) => option.label === picked)?.choice ?? "cancel";

				if (choice === "prompt") {
					ctx.ui.setEditorText(text);
					ctx.ui.notify("Review the command in your prompt and press Enter to run it.", "info");
				} else if (choice === "clipboard") {
					await copy(offer.command);
					ctx.ui.notify("Command copied to the clipboard.", "info");
				}
				return {
					content: [{ type: "text", text: resultText(choice, offer) }],
					details: { command: text, status: choice } satisfies HandDetails,
					// The next move is the user's; a follow-up from the agent would only talk over it.
					terminate: choice !== "cancel",
				};
			},

			renderCall(args, theme) {
				const head = `${theme.fg("toolTitle", theme.bold("robot_hand "))}${theme.fg("dim", args.reason ?? "")}`;
				const command = args.command ? (args.kind === "pi" ? args.command : `! ${args.command}`) : "";
				const lines = command.split("\n").map((line: string) => `  ${theme.fg("accent", line)}`);
				return new Text([head, ...lines].join("\n"), 0, 0);
			},

			renderResult(result, _options, theme) {
				const details = result.details as HandDetails | undefined;
				if (!details || typeof details.status !== "string") {
					const first = result.content[0];
					return new Text(first?.type === "text" ? first.text : "", 0, 0);
				}
				if (details.status === "waiting") return new Text(theme.fg("dim", "Waiting for you to take the command"), 0, 0);
				if (details.status === "prompt") return new Text(`${theme.fg("success", "✓ ")}In your prompt — press Enter to run it`, 0, 0);
				if (details.status === "clipboard") return new Text(`${theme.fg("success", "✓ ")}Copied to your clipboard`, 0, 0);
				return new Text(theme.fg("warning", "Declined — nothing placed or run"), 0, 0);
			},
		});
	};
}

export default createRobotHand();
