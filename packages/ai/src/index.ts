import type { AiProvider } from "@lifeos/application";

export class MockAiProvider implements AiProvider {
  async proposeMeetingOutputs(note: string) {
    return note.trim() ? [
      { type: "task" as const, title: "Review the captured meeting note", confidence: "Medium" as const },
      { type: "decision" as const, title: "Confirm the meeting outcome", confidence: "Low" as const },
      { type: "open-point" as const, title: "Resolve unanswered meeting questions", confidence: "Low" as const }
    ] : [];
  }

  async proposeKnowledgeNote(source: string) {
    const firstLine = source.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) ?? "Captured knowledge";
    return { title: firstLine, body: `# ${firstLine}\n\n${source.trim()}\n`, confidence: "Medium" as const };
  }
}
