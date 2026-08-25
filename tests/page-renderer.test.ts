import { PageRenderer } from "@/src/page/renderer";
import { scanPageSegments, type PageSegment } from "@/src/page/scanner";
import { createProtectedText } from "@/src/translation/protected-text";
import { describe, expect, it, vi } from "vitest";

function segment(anchor: Element, node: Text): PageSegment {
  return {
    id: "fixture",
    text: node.textContent ?? "",
    documentOrder: 0,
    nodes: [node],
    originalTexts: [node.textContent ?? ""],
    anchor,
  };
}

describe("PageRenderer", () => {
  it("translates and restores a direct ShadowRoot text node", () => {
    document.body.innerHTML = '<section id="shadow-host"></section>';
    const host = document.querySelector("#shadow-host");
    if (!(host instanceof HTMLElement)) throw new Error("invalid shadow host");
    const shadow = host.attachShadow({ mode: "open" });
    const node = document.createTextNode("Shadow text");
    shadow.append(node);
    const renderer = new PageRenderer();

    expect(
      renderer.apply(segment(host, node), "影子文本", "translated", "zh-CN"),
    ).toBe(true);
    expect(node.textContent).toBe("影子文本");
    expect(renderer.reconcile()).toEqual([]);

    renderer.restore();
    expect(node.textContent).toBe("Shadow text");
  });

  it("renders a quiet bilingual companion without a translation label", () => {
    document.body.innerHTML = "<article><p>Hello world</p></article>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    expect(
      renderer.apply(
        segment(paragraph, node),
        "译文：你好世界",
        "bilingual",
        "zh-CN",
      ),
    ).toBe(true);

    const host = paragraph.nextElementSibling;
    expect(host?.tagName).toBe("NORIXOR-TRANSLATION");
    expect(host?.shadowRoot?.querySelector("span")?.textContent).toBe(
      "你好世界",
    );
    expect(host?.shadowRoot?.querySelector("span")?.lang).toBe("zh-CN");
    const style = host?.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(style).toContain("font: inherit");
    expect(style).toContain("line-height: inherit");
    expect(style).toContain("letter-spacing: inherit");
    expect(style).not.toContain("font-size: 0.94em");
    expect(paragraph.textContent).toBe("Hello world");
  });

  it("does not erase the source when a provider returns only a label", () => {
    document.body.innerHTML = "<p>Keep this source</p>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    expect(
      renderer.apply(segment(paragraph, node), "译文：", "translated", "zh-CN"),
    ).toBe(false);
    expect(paragraph.textContent).toBe("Keep this source");
  });

  it("inherits the source typography and text flow in integrated bilingual mode", () => {
    document.body.innerHTML = `
      <article>
        <p style="font-family: Georgia; font-size: 21px; font-style: italic; font-weight: 600; letter-spacing: 0.12em; line-height: 32px; direction: rtl; text-align: end; writing-mode: horizontal-tb">
          Styled source
        </p>
      </article>
    `;
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text)) {
      throw new Error("invalid styled fixture");
    }
    const renderer = new PageRenderer();

    renderer.apply(segment(paragraph, node), "样式译文", "bilingual", "zh-CN");

    const host = paragraph.nextElementSibling as HTMLElement | null;
    expect(host?.style.fontFamily).toBe("Georgia");
    expect(host?.style.fontSize).toBe("21px");
    expect(host?.style.fontStyle).toBe("italic");
    expect(host?.style.fontWeight).toBe("600");
    expect(host?.style.letterSpacing).toBe("2.52px");
    expect(host?.style.lineHeight).toBe("32px");
    expect(host?.style.direction).toBe("rtl");
    expect(host?.style.textAlign).toBe("end");
    expect(host?.style.writingMode).toBe("horizontal-tb");

    const style = host?.shadowRoot?.querySelector("style")?.textContent ?? "";
    for (const declaration of [
      "direction: inherit",
      "font-family: inherit",
      "font-size: inherit",
      "font-style: inherit",
      "font-weight: inherit",
      "letter-spacing: inherit",
      "line-height: inherit",
      "text-align: inherit",
      "writing-mode: inherit",
    ]) {
      expect(style).toContain(declaration);
    }
    expect(style).not.toContain("font-size: 0.94em");
    expect(style).not.toContain("line-height: 1.55");
    expect(style).not.toContain("font-style: normal");
  });

  it("counter-flips an external companion beside reflected search-result text", () => {
    document.body.innerHTML = `
      <section style="transform: matrix(1, 0, 0, -1, 0, 0)">
        <h3 style="transform: matrix(1, 0, 0, -1, 0, 0); transform-origin: 20px 10px">
          Search result
        </h3>
      </section>
    `;
    const heading = document.querySelector("h3");
    const node = heading?.firstChild;
    if (!heading || !(node instanceof Text)) {
      throw new Error("invalid reflected search result fixture");
    }
    const renderer = new PageRenderer();

    renderer.apply(
      segment(heading, node),
      "搜索结果译文",
      "bilingual",
      "zh-CN",
    );

    const companion = heading.nextElementSibling as HTMLElement | null;
    expect(companion?.tagName).toBe("NORIXOR-TRANSLATION");
    expect(companion?.style.transform).toBe("matrix(1, 0, 0, -1, 0, 0)");
    expect(companion?.style.transformOrigin).toBe("20px 10px");
  });

  it("does not double-flip a companion placed inside a reflected anchor", () => {
    document.body.innerHTML = `
      <a href="#" style="transform: matrix(1, 0, 0, -1, 0, 0)">Result link</a>
    `;
    const link = document.querySelector("a");
    const node = link?.firstChild;
    if (!link || !(node instanceof Text)) {
      throw new Error("invalid reflected link fixture");
    }
    const renderer = new PageRenderer();

    renderer.apply(segment(link, node), "结果链接", "bilingual", "zh-CN");

    const companion = link.querySelector<HTMLElement>(
      ":scope > norixor-translation",
    );
    expect(companion?.style.transform).toBe("");
  });

  it("keeps list translations inside the original list item", () => {
    document.body.innerHTML = "<ol><li>First item</li></ol>";
    const item = document.querySelector("li");
    const node = item?.firstChild;
    if (!item || !(node instanceof Text)) throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    renderer.apply(segment(item, node), "第一项", "bilingual", "zh-CN");

    expect(item.querySelector(":scope > norixor-translation")).not.toBeNull();
    expect(document.querySelectorAll("ol > li")).toHaveLength(1);
  });

  it("places a body-level inline translation beside its source instead of after the body", () => {
    document.body.innerHTML =
      '<span id="source">Inline body text</span><main>Following content</main>';
    const source = document.querySelector("#source");
    const node = source?.firstChild;
    if (!source || !(node instanceof Text)) throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    renderer.apply(
      segment(document.body, node),
      "正文行内译文",
      "bilingual",
      "zh-CN",
    );

    expect(document.body.children[0]).toBe(source);
    expect(document.body.children[1]?.tagName).toBe("NORIXOR-TRANSLATION");
    expect(document.body.children[2]?.tagName).toBe("MAIN");
    expect(
      document.documentElement.querySelector(":scope > norixor-translation"),
    ).toBeNull();
  });

  it.each(["flex", "grid"])(
    "keeps translations within a %s item",
    (display) => {
      document.body.innerHTML = `<main style="display:${display}"><p>Hello layout</p></main>`;
      const paragraph = document.querySelector("p");
      const node = paragraph?.firstChild;
      if (!paragraph || !(node instanceof Text))
        throw new Error("invalid fixture");
      const renderer = new PageRenderer();

      renderer.apply(
        segment(paragraph, node),
        "布局译文",
        "bilingual",
        "zh-CN",
      );

      expect(document.querySelectorAll("main > p")).toHaveLength(1);
      expect(
        paragraph.querySelector(":scope > norixor-translation"),
      ).not.toBeNull();
    },
  );

  it("repositions an existing bilingual companion when its parent becomes flex", () => {
    document.body.innerHTML = "<main><p>Responsive layout</p></main>";
    const main = document.querySelector<HTMLElement>("main");
    const paragraph = main?.querySelector("p");
    const node = paragraph?.firstChild;
    if (!main || !paragraph || !(node instanceof Text)) {
      throw new Error("invalid responsive fixture");
    }
    const renderer = new PageRenderer();
    renderer.apply(
      segment(paragraph, node),
      "响应式译文",
      "bilingual",
      "zh-CN",
    );
    const companion = paragraph.nextElementSibling;
    expect(companion?.tagName).toBe("NORIXOR-TRANSLATION");

    main.style.display = "flex";
    expect(renderer.reconcile()).toEqual([]);

    expect(paragraph.nextElementSibling).toBeNull();
    expect(paragraph.querySelector(":scope > norixor-translation")).toBe(
      companion,
    );
    expect(companion?.hasAttribute("data-contained")).toBe(true);
  });

  it.each([
    '<main style="display:flex">Direct flex text</main>',
    '<main style="display:flex"><span>Inline flex item</span></main>',
  ])("keeps bilingual text within its semantic flex item: %s", (fixture) => {
    document.body.innerHTML = fixture;
    const anchor =
      document.querySelector("span") ?? document.querySelector("main");
    const node = anchor?.firstChild;
    if (!anchor || !(node instanceof Text)) {
      throw new Error("invalid flex semantic fixture");
    }
    const renderer = new PageRenderer();

    renderer.apply(segment(anchor, node), "弹性布局译文", "bilingual", "zh-CN");

    expect(anchor.querySelector(":scope > norixor-translation")).not.toBeNull();
    expect(anchor.nextElementSibling).toBeNull();
  });

  it("keeps table translations inside the original cell", () => {
    document.body.innerHTML =
      "<table><tbody><tr><td>Hello cell</td></tr></tbody></table>";
    const cell = document.querySelector("td");
    const node = cell?.firstChild;
    if (!cell || !(node instanceof Text)) throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    renderer.apply(segment(cell, node), "单元格译文", "bilingual", "zh-CN");

    expect(document.querySelectorAll("tr > td")).toHaveLength(1);
    expect(cell.querySelector(":scope > norixor-translation")).not.toBeNull();
  });

  it("replaces and restores only text owned by the current session", () => {
    document.body.innerHTML = "<p>Hello world</p>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    renderer.apply(
      segment(paragraph, node),
      "翻译：你好世界",
      "translated",
      "zh-CN",
    );
    expect(paragraph.textContent).toBe("你好世界");
    renderer.restore();
    expect(paragraph.textContent).toBe("Hello world");
  });

  it("preserves interactive controls and keeps their bilingual companion inside", () => {
    document.body.innerHTML = '<p><a href="/docs">Documentation</a></p>';
    const link = document.querySelector("a");
    const node = link?.firstChild;
    if (!link || !(node instanceof Text)) throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    renderer.apply(segment(link, node), "文档", "bilingual", "zh-CN");

    const companion = link.querySelector<HTMLElement>(
      ":scope > norixor-translation",
    );
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.childNodes[0]?.textContent).toBe("Documentation");
    expect(companion?.dataset.compactInteractive).toBe("");
    expect(link.nextElementSibling).toBeNull();
    expect(companion?.shadowRoot?.querySelector("span")?.textContent).toBe(
      "文档",
    );
  });

  it("replaces a stale bilingual companion when the source text changes", () => {
    document.body.innerHTML = "<article><p>Hello world</p></article>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    renderer.apply(segment(paragraph, node), "你好世界", "bilingual", "zh-CN");
    node.textContent = "Updated source";
    renderer.apply(
      segment(paragraph, node),
      "更新后的译文",
      "bilingual",
      "zh-CN",
    );

    const translations = document.querySelectorAll("norixor-translation");
    expect(translations).toHaveLength(1);
    expect(
      translations[0]?.shadowRoot?.querySelector("span")?.textContent,
    ).toBe("更新后的译文");
    renderer.restore();
    expect(document.querySelector("norixor-translation")).toBeNull();
    expect(paragraph.textContent).toBe("Updated source");
  });

  it("restores only renderer-owned text when invalidating a changed anchor", () => {
    document.body.innerHTML = "<p>Hello <strong>world</strong></p>";
    const paragraph = document.querySelector("p");
    const nodes = paragraph
      ? [...paragraph.childNodes].flatMap((node) =>
          node instanceof Text
            ? [node]
            : [...node.childNodes].filter(
                (child): child is Text => child instanceof Text,
              ),
        )
      : [];
    if (!paragraph || nodes.length !== 2) throw new Error("invalid fixture");
    const renderer = new PageRenderer();
    const source: PageSegment = {
      id: "compound",
      text: "Hello world",
      documentOrder: 0,
      nodes,
      originalTexts: nodes.map((node) => node.textContent ?? ""),
      anchor: paragraph,
    };

    renderer.apply(
      source,
      createProtectedText(["你好", "世界"]),
      "translated",
      "zh-CN",
    );
    nodes[1]!.textContent = "updated by page";
    expect(renderer.restoreAnchors(new Set([paragraph]))).toEqual(nodes);

    expect(nodes[0]?.textContent).toBe("Hello ");
    expect(nodes[1]?.textContent).toBe("updated by page");
  });

  it("translates across an inline link without replacing its DOM or click handler", () => {
    document.body.innerHTML =
      '<p>Read <a href="/docs">documentation</a> now.</p>';
    const paragraph = document.querySelector("p");
    const link = document.querySelector("a");
    if (!paragraph || !link) throw new Error("invalid inline link fixture");
    const click = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener("click", click);
    const source = scanPageSegments(document.body)[0];
    if (!source) throw new Error("missing inline link segment");
    const renderer = new PageRenderer();

    expect(
      renderer.apply(
        source,
        createProtectedText(["阅读 ", "文档", "。"]),
        "translated",
        "zh-CN",
      ),
    ).toBe(true);

    expect(document.querySelector("a")).toBe(link);
    expect(link.getAttribute("href")).toBe("/docs");
    expect(paragraph.textContent).toBe("阅读 文档。");
    link.click();
    expect(click).toHaveBeenCalledOnce();

    renderer.restore();
    expect(paragraph.innerHTML).toBe(
      'Read <a href="/docs">documentation</a> now.',
    );
  });

  it("hides or removes a bilingual companion with its source", () => {
    document.body.innerHTML = "<article><p>Hello world</p></article>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();
    renderer.apply(segment(paragraph, node), "你好世界", "bilingual", "zh-CN");
    const companion = document.querySelector<HTMLElement>(
      "norixor-translation",
    );

    paragraph.hidden = true;
    renderer.reconcile();
    expect(companion?.hidden).toBe(true);

    paragraph.hidden = false;
    renderer.reconcile();
    expect(companion?.hidden).toBe(false);

    node.remove();
    renderer.reconcile();
    expect(document.querySelector("norixor-translation")).toBeNull();
  });

  it("keeps an external bilingual companion beside a source element moved by the page", () => {
    document.body.innerHTML =
      "<section id='first'><p>Hello world</p></section><section id='second'></section>";
    const paragraph = document.querySelector("p");
    const second = document.querySelector("#second");
    const node = paragraph?.firstChild;
    if (!paragraph || !second || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();
    renderer.apply(segment(paragraph, node), "你好世界", "bilingual", "zh-CN");
    const companion = document.querySelector("norixor-translation");

    second.append(paragraph);
    renderer.reconcile();

    expect(paragraph.nextElementSibling).toBe(companion);
    expect(second.lastElementChild).toBe(companion);
    expect(document.querySelector("#first norixor-translation")).toBeNull();
  });

  it("keeps bilingual translations compact and inside interactive labels", () => {
    document.body.innerHTML =
      '<nav><a href="/history">History</a><button type="button">Hide</button></nav>';
    const link = document.querySelector("a");
    const button = document.querySelector("button");
    const linkText = link?.firstChild;
    const buttonText = button?.firstChild;
    if (
      !link ||
      !button ||
      !(linkText instanceof Text) ||
      !(buttonText instanceof Text)
    ) {
      throw new Error("invalid interactive fixture");
    }
    const renderer = new PageRenderer();

    renderer.apply(segment(link, linkText), "历史", "bilingual", "zh-CN");
    renderer.apply(segment(button, buttonText), "隐藏", "bilingual", "zh-CN");

    const linkTranslation = link.querySelector("norixor-translation");
    const buttonTranslation = button.querySelector("norixor-translation");
    expect(linkTranslation?.hasAttribute("data-compact-interactive")).toBe(
      true,
    );
    expect(buttonTranslation?.hasAttribute("data-compact-interactive")).toBe(
      true,
    );
    expect(link.nextElementSibling).toBe(button);
    expect(
      linkTranslation?.shadowRoot?.querySelector("span")?.textContent,
    ).toBe("历史");
    expect(
      buttonTranslation?.shadowRoot?.querySelector("span")?.textContent,
    ).toBe("隐藏");
    expect(linkTranslation?.shadowRoot?.textContent).toContain(
      "data-compact-interactive",
    );

    renderer.restore();
    expect(link.textContent).toBe("History");
    expect(button.textContent).toBe("Hide");
  });

  it.each([
    ["named", "article"],
    ["default", ""],
  ])("places a %s-slot bilingual companion in the assigned slot", (_, name) => {
    const customHost = document.createElement("x-renderer-slot");
    const source = document.createElement("p");
    source.textContent = "Assigned source";
    if (name) source.slot = name;
    customHost.append(source);
    const shadow = customHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `<section><slot${name ? ` name="${name}"` : ""}></slot></section>`;
    document.body.replaceChildren(customHost);
    const slot = shadow.querySelector("slot");
    const node = source.firstChild;
    if (!slot || !(node instanceof Text)) throw new Error("invalid fixture");
    const renderer = new PageRenderer();
    const assignedSegment = segment(source, node);
    assignedSegment.assignedSlot = { slot, source };

    expect(
      renderer.apply(
        assignedSegment,
        "Assigned translation",
        "bilingual",
        "zh-CN",
      ),
    ).toBe(true);

    const companion = customHost.querySelector("norixor-translation");
    expect(slot.assignedElements()).toEqual([source, companion]);
    expect(companion?.getAttribute("slot")).toBe(name || null);
    renderer.restore();
    expect(slot.assignedElements()).toEqual([source]);
  });

  it("forgets a detached replacement without restoring its detached text", () => {
    document.body.innerHTML = "<main><p>Removed source</p></main>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();
    const removedSegment = segment(paragraph, node);

    renderer.apply(
      removedSegment,
      "Removed translation",
      "translated",
      "zh-CN",
    );
    paragraph.remove();

    expect(renderer.reconcile()).toEqual([removedSegment]);
    renderer.restore();
    expect(paragraph.textContent).toBe("Removed translation");
  });

  it("does not restore a replacement text node removed from a live anchor", () => {
    document.body.innerHTML = "<p>Removed child</p>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    if (!paragraph || !(node instanceof Text))
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();

    renderer.apply(
      segment(paragraph, node),
      "Detached child",
      "translated",
      "zh-CN",
    );
    node.remove();
    renderer.restoreAnchors(new Set([paragraph]));

    expect(node.textContent).toBe("Detached child");
    expect(paragraph.textContent).toBe("");
  });

  it("restores renderer-owned text moved into another live anchor", () => {
    document.body.innerHTML =
      "<main><p id='source'>Moved source</p><aside id='destination'></aside></main>";
    const source = document.querySelector("#source");
    const destination = document.querySelector("#destination");
    const node = source?.firstChild;
    if (!source || !destination || !(node instanceof Text)) {
      throw new Error("invalid moved replacement fixture");
    }
    const renderer = new PageRenderer();

    renderer.apply(
      segment(source, node),
      "Moved translation",
      "translated",
      "zh-CN",
    );
    destination.append(node);

    expect(renderer.restoreAnchors(new Set([source]))).toEqual([node]);
    expect(node.textContent).toBe("Moved source");
    expect(destination.textContent).toBe("Moved source");
  });

  it("does not apply a late result to hidden, detached, or moved source text", () => {
    document.body.innerHTML = "<main><p>Late source</p><aside></aside></main>";
    const paragraph = document.querySelector("p");
    const node = paragraph?.firstChild;
    const aside = document.querySelector("aside");
    if (!paragraph || !(node instanceof Text) || !aside)
      throw new Error("invalid fixture");
    const renderer = new PageRenderer();
    const pendingSegment = segment(paragraph, node);

    paragraph.hidden = true;
    expect(
      renderer.apply(pendingSegment, "迟到译文", "bilingual", "zh-CN"),
    ).toBe(false);
    paragraph.hidden = false;
    aside.append(node);
    expect(
      renderer.apply(pendingSegment, "迟到译文", "bilingual", "zh-CN"),
    ).toBe(false);
    expect(document.querySelector("norixor-translation")).toBeNull();
  });
});
