// Últimas conversas do Claude Code de cada pasta, abaixo de Agents.
// Clique retoma a conversa numa aba nova da pasta; botão direito copia o comando.
// A coleta é o conversas.py do plugin do herdr de terminal (tui/ no repositório
// herdr-mods); o instalar.py copia ele para esta pasta.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, spaces, panes, run, theme, notify, checking, appHome, window } from "herdr";

// Mesmo main.js no Windows e no Linux: só o Python muda.
const WINDOWS = () => window()?.platform === "windows";
const SCRIPT = () => `${appHome()}/mods/conversas/conversas.py`;
const PYTHON = () => (WINDOWS() ? "python" : "python3");
const COMANDO = (id) => `claude --dangerously-skip-permissions --resume ${id}`;
const ATUALIZA_MS = 30000;

const norm = (p) => (p ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
const nome = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

function quando(seg) {
  const d = new Date(seg * 1000);
  const hoje = new Date();
  const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === hoje.toDateString()) return hh;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Aba nova no space que já está nessa pasta; senão, um space novo nela.
function retomar(c) {
  const argv = ["claude", "--dangerously-skip-permissions", "--resume", c.id];
  const alvo = norm(c.cwd);
  const todos = spaces();
  const aba = panes().find((p) => norm(p.cwd) === alvo)?.tab;
  const porPainel = aba && todos.find((s) => s.tabs.some((t) => t.id === aba))?.id;
  const space = porPainel ?? todos.find((s) => norm(s.folder) === alvo)?.id;
  if (space) run("tab.new", { space, folder: c.cwd, argv, name: c.titulo.slice(0, 24) });
  else run("space.new", { folder: c.cwd, argv });
}

export default class Conversas extends View {
  init(_props, cx) {
    this.grupos = [];
    this.erro = null;
    this.fechados = new Set();
    if (checking()) return;
    this.carregar(cx);
    cx.timer.every(ATUALIZA_MS, (cx) => this.carregar(cx));
  }

  carregar(cx) {
    if (this.carregando) return;
    this.carregando = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(PYTHON(), [SCRIPT(), "--listar"], { timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr.trim() || `saiu com ${r.code}`);
        this.grupos = JSON.parse(r.stdout);
        this.erro = null;
      } catch (e) {
        this.erro = String(e?.message ?? e);
      }
      this.carregando = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const linha = (c) =>
      v_flex()
        .id(`cv-${c.id}`)
        .ml(10)
        .px(8)
        .py(4)
        .flex_none()
        .rounded(8)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(`Clique: retomar · botão direito: copiar\n${COMANDO(c.id)}`)
        .on_click(() => retomar(c))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          cx.write_to_clipboard(COMANDO(c.id));
          notify({ title: "Comando copiado", body: COMANDO(c.id), level: "info", timeout: 3000 });
        })
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.titulo))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(quando(c.quando))))
        .child(div().text_size(10.5).truncate().text_color(t.dim).child(c.id));

    const grupo = (g) => {
      const aberto = !this.fechados.has(g.cwd);
      return [
        // Cabeçalho da pasta em faixa própria (fundo, ícone, negrito) para separar os projetos.
        h_flex()
          .id(`cg-${g.cwd}`)
          .mt(8)
          .mb(2)
          .px(8)
          .h(30)
          .flex_none()
          .gap(7)
          .items_center()
          .rounded(7)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .text_size(12.5)
          .font_semibold()
          .text_color(t.foreground)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(g.cwd)
          .on_click((_e, cx) => {
            aberto ? this.fechados.add(g.cwd) : this.fechados.delete(g.cwd);
            cx.notify();
          })
          .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().child(nome(g.cwd)))
          .child(div().flex_none().text_size(10.5).font_medium().text_color(t.muted).child(String(g.conversas.length)))
          .child(svg(`mods/workspace-chrome/chevron-${aberto ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim)),
        ...(aberto ? g.conversas.map(linha) : []),
      ];
    };

    // Painel lateral direito, no mesmo cartão de Files e Changes.
    const total = this.grupos.reduce((n, g) => n + g.conversas.length, 0);
    return v_flex()
      .id("conversas")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Conversas"))
          .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${total}`))
          .child(div().flex_1())
          .child(
            div()
              .id("cv-refresh")
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.text_color(t.foreground))
              .tooltip("Atualizar")
              .on_click((_e, cx) => this.carregar(cx))
              .child(this.carregando ? "…" : "↻"),
          ),
      )
      .when(Boolean(this.erro), (el) => el.child(div().p(14).text_size(12).text_color(t.blocked).child(this.erro)))
      .when(!this.erro && this.grupos.length === 0, (el) =>
        el.child(div().p(14).text_size(12).text_color(t.dim).child(this.carregando ? "Lendo conversas…" : "Nenhuma conversa encontrada.")))
      .child(v_flex().id("cv-lista").flex_1().min_h(0).p(6).overflow_y_scrollbar().children(this.grupos.flatMap(grupo)));
  }
}
