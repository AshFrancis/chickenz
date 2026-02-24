import type { Command } from "./types";

const MAX_HISTORY = 200;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  execute(cmd: Command) {
    cmd.execute();
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.onChange();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.onChange();
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.execute();
    this.undoStack.push(cmd);
    this.onChange();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange();
  }
}
