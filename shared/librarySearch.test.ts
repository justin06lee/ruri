import { describe, expect, test } from "bun:test";
import type { NamedComponent } from "./protocol.js";
import { searchComponents, stem, words } from "./librarySearch.js";

function entry(slug: string, name: string, over: Partial<NamedComponent> = {}): NamedComponent {
  return { id: slug, slug, name, aliases: [], files: [], note: "", shots: [], ts: 1, ...over };
}

const library = [
  entry("confirm-dialog", "the confirm dialog", {
    files: ["src/components/ConfirmDialog.tsx"],
    note: "a modal asking to confirm a destructive action",
  }),
  entry("price-card", "the pricing card", { files: ["src/components/PriceCard.tsx"], tags: ["pricing"] }),
  entry("navbar", "the top nav", { files: ["src/components/NavBar.tsx"], note: "links across the top" }),
  entry("settings-page", "the settings page", { files: ["src/pages/Settings.tsx"] }),
  entry("toast", "the toast", { files: ["src/components/Toast.tsx"], uses: ["src/styles.css:40"] }),
  entry("sidebar", "the sidebar", { files: ["src/Sidebar.tsx"], uses: ["src/styles.css:90"] }),
];

const find = (query: string) => searchComponents(library, query).map((item) => item.slug);

describe("finding what someone means", () => {
  test("words come apart and down to their stems", () => {
    expect(words("ConfirmDialog price-card the_nav")).toEqual([
      "confirm",
      "dialog",
      "price",
      "card",
      "the",
      "nav",
    ]);
    expect(stem("prices")).toBe(stem("price"));
    expect(stem("pricing")).toBe(stem("price"));
    expect(stem("confirmation")).toBe("confirm");
    expect(stem("cards")).toBe("card");
    expect(stem("class")).toBe("class");
  });

  test("other forms of the words still find it", () => {
    expect(find("confirmation dialog")[0]).toBe("confirm-dialog");
    expect(find("price cards")[0]).toBe("price-card");
    expect(find("prices")[0]).toBe("price-card");
    expect(find("settings screen")[0]).toBe("settings-page");
  });

  test("a short word finds the longer one it starts, and synonyms count", () => {
    expect(find("nav")).toContain("navbar");
    expect(find("navigation")[0]).toBe("navbar");
    expect(find("popup")[0]).toBe("confirm-dialog");
    expect(find("notification")[0]).toBe("toast");
    expect(find("tile")).toContain("price-card");
  });

  test("the article and filler words don't stop a match; a one-letter typo doesn't either", () => {
    expect(find("the toast component")).toEqual(["toast"]);
    expect(find("a pricing thing")[0]).toBe("price-card");
    expect(find("sidebr")).toEqual(["sidebar"]);
  });

  test("half a query is a weaker match, under half none at all", () => {
    expect(find("confirm spaceship")).toEqual(["confirm-dialog"]);
    expect(find("confirm spaceship rocket")).toEqual([]);
    expect(find("spaceship")).toEqual([]);
  });

  test("the name outranks a stylesheet everyone reaches into", () => {
    expect(find("styles")).toEqual(["sidebar", "toast"]);
    expect(find("the top nav")[0]).toBe("navbar");
    expect(find("sidebar")[0]).toBe("sidebar");
  });
});
