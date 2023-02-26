import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { Configuration, OpenAIApi } from "openai";
import { v4 as uuidv4 } from "uuid";

interface LoomSettings {
  apiKey: string;
  model: string;
  maxTokens: number;
  n: number;
}

const DEFAULT_SETTINGS: LoomSettings = {
  apiKey: "",
  model: "code-davinci-002",
  maxTokens: 64,
  n: 5,
};

interface Node {
  text: string;
  parentId?: string;
  unread: boolean;
  lastVisited?: number;
}

interface NoteState {
  current: string;
  nodes: Node[];
}

export default class LoomPlugin extends Plugin {
  settings: LoomSettings;
  state: Record<string, NoteState>;

  editor: Editor;
  view: LoomView;

  openai: OpenAIApi;

  async onload() {
    await this.loadSettings();
    await this.loadState();

    this.addSettingTab(new LoomSettingTab(this.app, this));

    const configuration = new Configuration({
      apiKey: this.settings.apiKey,
    });
    this.openai = new OpenAIApi(configuration);

    this.addCommand({
      id: "loom-complete",
      name: "Complete",
      icon: "wand",
      editorCallback: async (editor: Editor, view: MarkdownView) =>
        this.complete(this.settings.model, this.settings.maxTokens, this.settings.n, editor),
      hotkeys: [ { modifiers: ["Ctrl"], key: " " } ],
    });

    this.addCommand({
      id: "loom-create-child",
      name: "Create child of current node",
      icon: "plus",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        this.app.workspace.trigger("loom:create-child", this.state[file.path].current);
      },
      hotkeys: [ { modifiers: ["Ctrl", "Shift"], key: " " } ],
    });

    this.addCommand({
      id: "loom-switch-to-next-sibling",
      name: "Switch to next sibling",
      icon: "arrow-down",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const state = this.state[file.path];

        this.app.workspace.trigger("loom:switch-to", this.nextSibling(state.current, state));
      },
      hotkeys: [ { modifiers: ["Alt"], key: "ArrowDown" } ],
    });

    this.addCommand({
      id: "loom-switch-to-previous-sibling",
      name: "Switch to previous sibling",
      icon: "arrow-up",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const state = this.state[file.path];

        this.app.workspace.trigger("loom:switch-to", this.prevSibling(state.current, state));
      },
      hotkeys: [ { modifiers: ["Alt"], key: "ArrowUp" } ],
    });

    this.addCommand({
      id: "loom-switch-to-parent",
      name: "Switch to parent",
      icon: "arrow-left",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const state = this.state[file.path];

        const parentId = state.nodes[state.current].parentId;
        if (parentId) this.app.workspace.trigger("loom:switch-to", parentId);
      },
      hotkeys: [ { modifiers: ["Alt"], key: "ArrowLeft" } ],
    });

    this.addCommand({
      id: "loom-switch-to-child",
      name: "Switch to child",
      icon: "arrow-right",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const state = this.state[file.path];

        const children = Object.entries(state.nodes)
          .filter(([id, node]) => node.parentId === state.current)
          .sort(([id1, node1], [id2, node2]) => node2.lastVisited - node1.lastVisited);
        if (children.length > 0) this.app.workspace.trigger("loom:switch-to", children[0][0]);
      },
      hotkeys: [ { modifiers: ["Alt"], key: "ArrowRight" } ],
    });

    this.addCommand({
      id: "loom-delete-current-node",
      name: "Delete current node",
      icon: "trash",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const state = this.state[file.path];

        this.app.workspace.trigger("loom:delete", state.current);
      },
      hotkeys: [ { modifiers: ["Alt"], key: "Backspace" } ],
    });

    this.addCommand({
      id: "loom-debug-reset-state",
      name: "Debug: Reset state",
      callback: async () => {
        this.state = {};
        await this.save();
      },
    });

    this.registerView(
      "loom",
      (leaf) => {
        this.view = new LoomView(leaf, () => {
          const file = this.app.workspace.getActiveFile();
          if (file) return this.state[file.path];
          return null;
        });
        return this.view;
      },
      (id) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          this.state[file.path].current = id;
          this.save();
          this.view.render();
        }
      }
    );

    try {
    const loomExists = this.app.workspace.getLeavesOfType("loom").length > 0;
    if (!loomExists)
      this.app.workspace.getRightLeaf(false).setViewState({
        type: "loom",
      });
    } catch (e) { console.error(e); } finally { console.log("CELESTE WILL REMOVE THIS EVENTUALLY"); } // this wasn't working before?

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor: Editor, view: ItemView) => {
        if (!this.state[view.file.path]) this.state[view.file.path] = { nodes: {} };

        if (this.state[view.file.path].current) {
          const current = this.state[view.file.path].current;

          let ancestors = [];
          let node = current;
          while (node) {
            node = this.state[view.file.path].nodes[node].parentId;
            if (node) ancestors.push(node);
          }
          ancestors = ancestors.reverse();

          const text = editor.getValue();
          const ancestorTexts =
            ancestors.map((id) => this.state[view.file.path].nodes[id].text);

          for (let i = 0; i < ancestors.length; i++) {
            const textBefore = ancestorTexts.slice(0, i + 1).join("");

            if (!text.startsWith(textBefore)) {
              const newPrefix = ancestorTexts.slice(0, i).join("");
              const newText = text.substring(newPrefix.length);

              const id = uuidv4();
              this.state[view.file.path].nodes[id] = {
                text: newText,
                parentId: i === 0 ? null : ancestors[i - 1],
                unread: false,
              };

              this.app.workspace.trigger("loom:switch-to", id);
              return;
            }
          }

          const previousText = ancestorTexts.join("") + this.state[view.file.path].nodes[current].text;
          const children = Object.values(this.state[view.file.path].nodes).filter(
            (node) => node.parentId === current
          );
          if (children.length > 0 && text !== previousText) {
            const id = uuidv4();
            this.state[view.file.path].nodes[id] = {
              text: text.substring(ancestorTexts.join("").length),
              parentId: this.state[view.file.path].nodes[current].parentId,
              unread: false,
            };

            this.app.workspace.trigger("loom:switch-to", id);
            return;
          }

          this.state[view.file.path].nodes[current].text =
            text.slice(ancestorTexts.join("").length);
        } else {
          const current = uuidv4();
          this.state[view.file.path].current = current;
          this.state[view.file.path].nodes[current] = {
            text: editor.getValue(),
            parentId: null,
            unread: false,
          };
        }

        this.save();

        this.view.render();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("loom:switch-to", (id: string) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        this.state[file.path].current = id;
        this.state[file.path].nodes[id].unread = false;
        this.state[file.path].nodes[id].lastVisited = Date.now();

        const text = this.fullText(id, this.state[file.path]);
        this.editor.setValue(text);

        this.save();
        this.view.render();
      })
    );

    this.registerEvent(
      this.app.workspace.on("loom:create-child", (id: string) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        const newId = uuidv4();
        this.state[file.path].nodes[newId] = {
          text: "",
          parentId: id,
          unread: false,
        };

        this.save();
        this.view.render();

        this.app.workspace.trigger("loom:switch-to", newId);
      })
    );

    this.registerEvent(
      this.app.workspace.on("loom:delete", (id: string) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        let nextId = this.nextSibling(id, this.state[file.path]);
        if (!nextId) nextId = this.state[file.path].nodes[id].parentId;
        if (!nextId) return;

        let deletedIds = [id];

        const deleteChildren = (id: string) => {
          for (const [id_, node] of Object.entries(this.state[file.path].nodes))
            if (node.parentId === id) {
              deleteChildren(id_);
              delete this.state[file.path].nodes[id_];
              deletedIds.push(id_);
            }
        };

        delete this.state[file.path].nodes[id];
        deleteChildren(id);

        this.save();
        this.view.render();

        // TODO
        if (deletedIds.includes(nextId)) console.error("deleted nextId");

        if (deletedIds.includes(this.state[file.path].current))
          this.app.workspace.trigger("loom:switch-to", nextId);
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.view.render();
        this.app.workspace.iterateRootLeaves((leaf) => {
          if (leaf.view instanceof MarkdownView && leaf.view.file.path === file.path)
            this.editor = leaf.view.editor;
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf.view;
        if (view instanceof MarkdownView) this.editor = view.editor;
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.state[file.path] = this.state[oldPath];
        delete this.state[oldPath];
        this.save();
      }),
    );

    const activeFile = this.app.workspace.getActiveFile();
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file.path === activeFile.path)
        this.editor = leaf.view.editor;
    });
  }

  async complete(model: string, maxTokens: number, n: number, editor: Editor) {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    const state = this.state[file.path];
    let prompt = this.fullText(state.current, state);

    const trailingSpace = prompt.match(/\s+$/);
    prompt = prompt.replace(/\s+$/, "");

    let completions = (
      await this.openai.createCompletion({
        model,
        prompt,
        max_tokens: maxTokens,
        n,
        temperature: 1,
      })
    ).data.choices.map((choice) => choice.text);

    let ids = [];
    for (const completion of completions) {
      let completion_ = completion;

      if (trailingSpace && completion_[0] === " ") completion_ = completion_.slice(1);

      const id = uuidv4();
      state.nodes[id] = {
        text: completion_,
        parentId: state.current,
        unread: true,
      };
      ids.push(id);
    }

    if (ids.length > 0) this.app.workspace.trigger("loom:switch-to", ids[0]);

    this.save();
    this.view.render();
  }

  fullText(id: string, state: NoteState) {
    let text = "";

    let current = id;
    while (current) {
      text = state.nodes[current].text + text;
      current = state.nodes[current].parentId;
    }

    return text;
  }

  nextSibling(id: string, state: NoteState) {
    const parentId = state.nodes[state.current].parentId;
    const siblings = Object.entries(state.nodes)
      .filter(([id, node]) => node.parentId === parentId)
      .map(([id, node]) => id);

    if (siblings.length === 1) return null;

    const nextIndex = (siblings.indexOf(state.current) + 1) % siblings.length;
    return siblings[nextIndex];
  }

  prevSibling(id: string, state: NoteState) {
    const parentId = state.nodes[state.current].parentId;
    const siblings = Object.entries(state.nodes)
      .filter(([id, node]) => node.parentId === parentId)
      .map(([id, node]) => id);

    if (siblings.length === 1) return null;

    const prevIndex = (siblings.indexOf(state.current) + siblings.length - 1) % siblings.length;
    return siblings[prevIndex];
  }

  async loadSettings() {
    const settings = await (async () => {
      const data = await this.loadData();
      if (data) return data.settings || {};
      return {};
    })();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
  }

  async loadState() {
    this.state = await (async () => {
      const data = await this.loadData();
      if (data) return data.state || {};
      return {};
    })();
  }

  async save() {
    await this.saveData({ settings: this.settings, state: this.state });
  }
}

class LoomView extends ItemView {
  getNoteState: () => NoteState;

  constructor(leaf: WorkspaceLeaf, getNoteState: () => NoteState) {
    super(leaf);

    this.getNoteState = getNoteState;
    this.render();
  }

  render() {
    this.containerEl.empty();

    const state = this.getNoteState();
    const container = this.containerEl.createDiv({ cls: "outline" });

    if (!state) {
      container.createEl("div", { cls: "pane-empty", text: "No note selected." });
      return;
    }

    const nodeEntries = Object.entries(state.nodes);

    let onlyRootNode = null;
    const rootNodes = nodeEntries.filter(
      ([, node]) => node.parentId === null
    );
    if (rootNodes.length === 1) onlyRootNode = rootNodes[0][0];

    const renderChildren = (parentId: string | null, container: HTMLElement) => {
      const children = nodeEntries.filter(([id, node]) => node.parentId === parentId);
      if (children.length === 0) return;

      for (const [id, node] of children) {
        const childContainer = container.createDiv({});

        const nodeDiv = childContainer.createDiv(
          { cls: `is-clickable outgoing-link-item tree-item-self loom-node${node.unread ? " loom-node-unread" : ""}${id === state.current ? " is-active" : ""}` }
        );

        if (node.unread) nodeDiv.createDiv({ cls: "loom-node-unread-indicator" });
        const nodeText = nodeDiv.createEl(node.text ? "span" : "em", { cls: "loom-node-inner tree-item-inner", text: node.text || "No text" });
        nodeText.addEventListener("click", () => this.app.workspace.trigger("loom:switch-to", id));
    
        const createChildDiv = nodeDiv.createEl("div", { cls: "loom-icon" });
        setIcon(createChildDiv, "plus");
        createChildDiv.addEventListener("click", () => this.app.workspace.trigger("loom:create-child", id));

        if (id !== onlyRootNode) {
          const trashDiv = nodeDiv.createEl("div", { cls: "loom-icon" })
          setIcon(trashDiv, "trash");
          trashDiv.addEventListener("click", () => this.app.workspace.trigger("loom:delete", id));
        }

        const childrenDiv = childContainer.createDiv({ cls: "loom-children" });
        renderChildren(id, childrenDiv);
      }
    };

    renderChildren(null, container);
  }

  getViewType(): string {
    return "loom";
  }

  getDisplayText(): string {
    return "Loom";
  }

  getIcon(): string {
    return "network";
  }
}

class LoomSettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Required")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiKey).onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.save();
        })
      );

    new Setting(containerEl).setName("Model").addText((text) =>
      text.setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value;
        await this.plugin.save();
      })
    );

    new Setting(containerEl).setName("Length (in tokens)").addText((text) =>
      text
        .setValue(this.plugin.settings.maxTokens.toString())
        .onChange(async (value) => {
          this.plugin.settings.maxTokens = parseInt(value);
          await this.plugin.save();
        })
    );

    new Setting(containerEl).setName("Number of completions").addText((text) =>
      text
        .setValue(this.plugin.settings.n.toString())
        .onChange(async (value) => {
          this.plugin.settings.n = parseInt(value);
          await this.plugin.save();
        })
    );
  }
}