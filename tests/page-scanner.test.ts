import { describe, expect, it, vi } from "vitest";
import { pageSegmentAnchor, scanPageSegments } from "@/src/page/scanner";
import { createProtectedText } from "@/src/translation/protected-text";

describe("scanPageSegments", () => {
  it("skips assigned light-DOM text while its rendered slot is hidden", () => {
    document.body.innerHTML =
      "<x-hidden-slot><p>Assigned text</p></x-hidden-slot>";
    const host = document.querySelector("x-hidden-slot");
    if (!host) throw new Error("missing slot host");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<slot hidden></slot>";

    expect(scanPageSegments(document.body)).toEqual([]);

    shadow.querySelector("slot")?.removeAttribute("hidden");
    expect(
      scanPageSegments(document.body).map((segment) => segment.text),
    ).toEqual(["Assigned text"]);
  });

  it("keeps open shadow text in composed light-shadow-light context order", () => {
    document.body.innerHTML =
      "<main><p>Light before</p><x-shadow></x-shadow><p>Light after</p></main>";
    const host = document.querySelector("x-shadow");
    const shadow = host?.attachShadow({ mode: "open" });
    if (!shadow) throw new Error("missing shadow fixture");
    shadow.innerHTML = "<p>Shadow middle</p>";

    const ordered = scanPageSegments(document.body)
      .sort((left, right) => left.documentOrder - right.documentOrder)
      .map((segment) => segment.text);

    expect(ordered).toEqual(["Light before", "Shadow middle", "Light after"]);
  });

  it("scans assigned slot content in flattened named-slot order without unassigned light DOM", () => {
    const host = document.createElement("x-slotted-copy");
    host.innerHTML = `
      <span slot="second">Second assigned</span>
      <span>Default assigned</span>
      <span slot="missing">Unassigned light text</span>
    `;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <p><slot name="second">Second fallback</slot></p>
      <p><slot>Default fallback</slot></p>
    `;
    document.body.replaceChildren(host);

    const ordered = scanPageSegments(document.body)
      .sort((left, right) => left.documentOrder - right.documentOrder)
      .map((segment) => segment.text);

    expect(ordered).toEqual(["Second assigned", "Default assigned"]);
    expect(ordered.join(" ")).not.toContain("fallback");
    expect(ordered.join(" ")).not.toContain("Unassigned");
  });

  it("records the concrete named and default slots used by assigned text", () => {
    const host = document.createElement("x-slot-context");
    host.innerHTML = `
      <p id="named" slot="article">Named assigned</p>
      <p id="default">Default assigned</p>
    `;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<slot name="article"></slot><slot></slot>';
    document.body.replaceChildren(host);

    const segments = scanPageSegments(document.body).sort(
      (left, right) => left.documentOrder - right.documentOrder,
    );
    const slots = shadow.querySelectorAll("slot");

    expect(segments.map((segment) => segment.text)).toEqual([
      "Named assigned",
      "Default assigned",
    ]);
    expect(segments[0]?.assignedSlot).toEqual({
      slot: slots[0],
      source: host.querySelector("#named"),
    });
    expect(segments[1]?.assignedSlot).toEqual({
      slot: slots[1],
      source: host.querySelector("#default"),
    });
  });

  it("uses slot fallback children when no nodes are assigned", () => {
    const host = document.createElement("x-fallback-copy");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<p>Before <slot><strong>Fallback copy</strong></slot> after</p>";
    document.body.replaceChildren(host);

    expect(
      scanPageSegments(document.body).map((segment) => segment.text),
    ).toEqual(["Before Fallback copy after"]);
  });

  it("does not enter a closed shadow root", () => {
    const host = document.createElement("x-closed-copy");
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = "<p>Closed shadow copy</p>";
    document.body.replaceChildren(host);

    expect(scanPageSegments(document.body)).toEqual([]);
  });

  it("groups inline text, includes visible controls, and skips excluded content", () => {
    document.body.innerHTML = `
      <main>
        <p>Hello <strong>world</strong>.</p>
        <pre>const secret = true</pre>
        <input value="do not translate">
        <button>Translate this action</button>
        <nav>Translate navigation</nav>
        <div role="toolbar">Translate toolbar text</div>
        <p class="notranslate">Brand name</p>
      </main>
    `;

    const segments = scanPageSegments(document.body);

    expect(segments.map((segment) => segment.text)).toEqual([
      "Hello world.",
      "Translate this action",
      "Translate navigation",
      "Translate toolbar text",
    ]);
    expect(segments[0]?.nodes).toHaveLength(3);
  });

  it("skips standalone icon, format, emoji, and punctuation-only text", () => {
    document.body.innerHTML = `
      <main>
        <span>\uE123</span>
        <span>\u200C</span>
        <span>👌</span>
        <span>···</span>
        <p>保留文字 <span>👌</span></p>
      </main>
    `;

    expect(
      scanPageSegments(document.body).map((segment) => segment.text),
    ).toEqual(["保留文字"]);
  });

  it("resolves newly appended inline text to its complete semantic anchor", () => {
    document.body.innerHTML = "<main><p>Lead <strong>tail</strong></p></main>";
    const tail = document.querySelector("strong")?.firstChild;
    if (!(tail instanceof Text)) throw new Error("invalid fixture");

    expect(pageSegmentAnchor(tail, document.body)).toBe(
      document.querySelector("p"),
    );
  });

  it("discovers translatable text inside nested open shadow roots", () => {
    const outer = document.createElement("section");
    const outerRoot = outer.attachShadow({ mode: "open" });
    outerRoot.innerHTML =
      "<article><p>Shadow paragraph</p><button>Shadow action</button><x-inner></x-inner></article>";
    const inner = outerRoot.querySelector("x-inner");
    const innerRoot = inner?.attachShadow({ mode: "open" });
    if (!innerRoot) throw new Error("missing nested shadow root");
    innerRoot.innerHTML = "<p>Nested shadow paragraph</p>";
    document.body.replaceChildren(outer);

    expect(
      scanPageSegments(document.body).map((segment) => segment.text),
    ).toEqual(["Shadow paragraph", "Shadow action", "Nested shadow paragraph"]);
  });

  it("scans direct text children of open shadow roots and applies host exclusions", () => {
    const host = document.createElement("x-direct-copy");
    const root = host.attachShadow({ mode: "open" });
    root.append(document.createTextNode("Direct shadow copy"));

    const extensionHost = document.createElement("noritrans-own-ui");
    extensionHost.setAttribute("data-noritrans-ui", "floating-control");
    const extensionRoot = extensionHost.attachShadow({ mode: "open" });
    extensionRoot.append(document.createTextNode("Extension UI copy"));
    document.body.replaceChildren(host, extensionHost);

    const segments = scanPageSegments(document.body);

    expect(segments.map((segment) => segment.text)).toEqual([
      "Direct shadow copy",
    ]);
    expect(segments[0]?.anchor).toBe(host);
  });

  it("keeps incremental direct ShadowRoot text IDs distinct and honors seen nodes", () => {
    const host = document.createElement("x-direct-repeat");
    const root = host.attachShadow({ mode: "open" });
    const seen = new WeakSet<Text>();
    root.append(document.createTextNode("Repeat"));
    document.body.replaceChildren(host);

    const first = scanPageSegments(document.body, seen);
    root.append(document.createTextNode("Repeat"));
    const incremental = scanPageSegments(document.body, seen);

    expect(first).toHaveLength(1);
    expect(incremental).toHaveLength(1);
    expect(incremental[0]?.id).not.toBe(first[0]?.id);
    expect(scanPageSegments(document.body, seen)).toEqual([]);
  });

  it("assigns unique stable IDs to repeated direct ShadowRoot children", () => {
    const host = document.createElement("x-repeated-copy");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<p>Repeated text</p><p>Repeated text</p>";
    document.body.replaceChildren(host);

    const first = scanPageSegments(document.body);
    const second = scanPageSegments(document.body);

    expect(first.map((segment) => segment.text)).toEqual([
      "Repeated text",
      "Repeated text",
    ]);
    expect(new Set(first.map((segment) => segment.id)).size).toBe(2);
    expect(second.map((segment) => segment.id)).toEqual(
      first.map((segment) => segment.id),
    );
  });

  it("does not scan nodes already marked as seen", () => {
    document.body.innerHTML = "<p>First paragraph</p>";
    const seen = new WeakSet<Text>();

    expect(scanPageSegments(document.body, seen)).toHaveLength(1);
    expect(scanPageSegments(document.body, seen)).toHaveLength(0);
  });

  it("keeps incremental repeated text IDs distinct within the same anchor", () => {
    document.body.innerHTML = "<p>Repeat</p>";
    const seen = new WeakSet<Text>();
    const first = scanPageSegments(document.body, seen);
    document.querySelector("p")?.append(document.createTextNode("Repeat"));
    const incremental = scanPageSegments(document.body, seen);

    expect(first).toHaveLength(1);
    expect(incremental).toHaveLength(1);
    expect(incremental[0]?.id).not.toBe(first[0]?.id);
  });

  it("keeps a single oversized text node intact for request-layer splitting", () => {
    const original = `Beginning ${"long text ".repeat(620)}ending`;
    document.body.innerHTML = "<p></p>";
    const paragraph = document.querySelector("p");
    paragraph?.append(document.createTextNode(original));

    const sourceNode = paragraph?.firstChild;
    const segments = scanPageSegments(document.body);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(original);
    expect(paragraph?.childNodes).toHaveLength(1);
    expect(paragraph?.firstChild).toBe(sourceNode);
    expect(paragraph?.textContent).toBe(original);
  });

  it("derives stable IDs from document position and text instead of scan time", () => {
    document.body.innerHTML =
      "<main><p>Stable paragraph</p><p>Stable paragraph</p></main>";

    const first = scanPageSegments(document.body);
    const second = scanPageSegments(document.body);

    expect(second.map((segment) => segment.id)).toEqual(
      first.map((segment) => segment.id),
    );
    expect(new Set(first.map((segment) => segment.id)).size).toBe(2);
  });

  it("keeps one-character natural-language text and skips standalone numbers", () => {
    document.body.innerHTML = "<main><p>你</p><p>123.45</p></main>";

    const segments = scanPageSegments(document.body);

    expect(segments.map((segment) => segment.text)).toEqual(["你"]);
  });

  it("respects translation and visibility exclusions placed on the scan root", () => {
    document.body.innerHTML = "<p>Root excluded text</p>";
    document.body.setAttribute("translate", "no");
    expect(scanPageSegments(document.body)).toEqual([]);

    document.body.removeAttribute("translate");
    document.body.setAttribute("aria-hidden", "true");
    expect(scanPageSegments(document.body)).toEqual([]);
    document.body.removeAttribute("aria-hidden");
  });

  it("keeps webpage translation out of native, generic, and extension subtitle DOM", () => {
    document.body.innerHTML = `
      <main>
        <p>Regular article paragraph</p>
        <div class="ytp-caption-segment">YouTube native caption</div>
        <div class="player-timedtext"><span>Netflix native caption</span></div>
        <div class="video-player">
          <video></video>
          <div class="custom-video-subtitle-layer">Generic subtitle cue</div>
          <div class="live-caption-container">Generic caption cue</div>
        </div>
        <section data-noritrans-ui="subtitle-overlay">Extension subtitle</section>
        <section data-noritrans-ui>Extension UI without a surface marker</section>
        <figcaption>Ordinary figure description</figcaption>
      </main>
    `;

    expect(
      scanPageSegments(document.body).map((segment) => segment.text),
    ).toEqual(["Regular article paragraph", "Ordinary figure description"]);
  });

  it("translates ordinary page subtitles and captions outside a video player", () => {
    document.body.innerHTML = `
      <main>
        <h1>Product title</h1>
        <p class="subtitle">Product subtitle that belongs to the page</p>
        <section id="caption-story">Article caption used as body copy</section>
      </main>
    `;

    expect(
      scanPageSegments(document.body).map((segment) => segment.text),
    ).toEqual([
      "Product title",
      "Product subtitle that belongs to the page",
      "Article caption used as body copy",
    ]);
  });

  it("keeps controls independent while translating an inline link in sentence context", () => {
    document.body.innerHTML = `
      <main>
        <div><button>Save</button><button>Cancel</button></div>
        <p>Read <a href="/docs">documentation</a> now.</p>
      </main>
    `;

    const segments = scanPageSegments(document.body);

    expect(segments.map((segment) => segment.text)).toEqual([
      "Save",
      "Cancel",
      "Read documentation now.",
    ]);
    expect(segments.map((segment) => segment.anchor.tagName)).toEqual([
      "BUTTON",
      "BUTTON",
      "P",
    ]);
    expect(segments[2]?.nodes).toHaveLength(3);
  });

  it("splits inline-heavy content before protected markers exceed the request budget", () => {
    document.body.innerHTML = "<p></p>";
    const paragraph = document.querySelector("p");
    paragraph?.append(
      document.createTextNode("\uE000NT1:0:marker-like page text"),
      ...Array.from({ length: 4_999 }, () => document.createTextNode("x")),
    );

    const segments = scanPageSegments(document.body);
    const repeated = scanPageSegments(document.body);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.flatMap((segment) => segment.nodes)).toHaveLength(5_000);
    expect(
      segments.every(
        (segment) => createProtectedText(segment.originalTexts).length <= 2_800,
      ),
    ).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      `\uE000NT1:0:marker-like page text${"x".repeat(4_999)}`,
    );
    expect(repeated.map((segment) => segment.id)).toEqual(
      segments.map((segment) => segment.id),
    );
  });

  it("keeps thousands of inline sibling elements on the indexed path", () => {
    document.body.innerHTML = `<p>${Array.from(
      { length: 5_000 },
      (_, index) => `<span>${String.fromCharCode(97 + (index % 26))}</span>`,
    ).join("")}</p>`;

    const childrenGetter = vi.spyOn(Element.prototype, "children", "get");
    try {
      const segments = scanPageSegments(document.body);
      expect(segments.flatMap((segment) => segment.nodes)).toHaveLength(5_000);
      expect(childrenGetter.mock.calls.length).toBeLessThan(20);
    } finally {
      childrenGetter.mockRestore();
    }
  }, 20_000);

  it("keeps a standalone or block link as its own semantic segment", () => {
    document.body.innerHTML = `
      <a id="standalone" href="/one">Standalone link</a>
      <p><a id="block" href="/two" style="display:block">Block link</a></p>
      <div><button>Save</button><a id="menu-link" href="/three">Menu link</a></div>
    `;

    const segments = scanPageSegments(document.body);

    expect(segments.map((segment) => segment.text)).toEqual([
      "Standalone link",
      "Block link",
      "Save",
      "Menu link",
    ]);
    expect(segments.map((segment) => segment.anchor.id)).toEqual([
      "standalone",
      "block",
      "",
      "menu-link",
    ]);
  });
});
