import { describe, expect, test } from "bun:test";
import {
  addFolder,
  firstLayout,
  flatOrder,
  folderOf,
  moveInLayout,
  removeFolder,
  sameLayout,
  setFolder,
  tidyLayout,
  type SidebarLayout,
} from "./sidebar.js";

const ids = ["a", "b", "c", "d"];
const flat: SidebarLayout = { order: [...ids], folders: [] };
/** a, then a folder of b and c, then d. */
const filed: SidebarLayout = {
  order: ["a", "F", "d"],
  folders: [{ id: "F", name: "work", projects: ["b", "c"] }],
};

describe("tidyLayout", () => {
  test("nothing saved is every project, in the order given", () => {
    expect(tidyLayout(undefined, ids)).toEqual(flat);
  });

  test("a project the layout has never heard of joins the end of the top level", () => {
    expect(tidyLayout(filed, [...ids, "e"]).order).toEqual(["a", "F", "d", "e"]);
  });

  test("a project that is gone leaves the top level and its folder", () => {
    const tidy = tidyLayout(filed, ["a", "c"]);
    expect(tidy.order).toEqual(["a", "F"]);
    expect(tidy.folders[0]?.projects).toEqual(["c"]);
  });

  test("nothing stands in two places: the first folder to name a project has it", () => {
    const tidy = tidyLayout(
      {
        order: ["a", "b", "F", "G", "a"],
        folders: [
          { id: "F", name: "one", projects: ["b", "b"] },
          { id: "G", name: "two", projects: ["b", "c"] },
          { id: "F", name: "again", projects: ["d"] },
        ],
      },
      ids,
    );
    expect(tidy.order).toEqual(["a", "F", "G", "d"]);
    expect(tidy.folders.map((f) => f.projects)).toEqual([["b"], ["c"]]);
  });

  test("a folder the top level forgot still stands, and folders follow the top level's order", () => {
    const tidy = tidyLayout(
      {
        order: ["G", "a"],
        folders: [
          { id: "F", name: "one", projects: ["b"] },
          { id: "G", name: "two", projects: ["c"] },
        ],
      },
      ids,
    );
    expect(tidy.order).toEqual(["G", "a", "F", "d"]);
    expect(tidy.folders.map((f) => f.id)).toEqual(["G", "F"]);
  });

  test("what isn't a layout at all is still tidied into one", () => {
    const junk = { order: "nope", folders: [null, { id: 3 }, { id: "F" }] } as unknown as SidebarLayout;
    expect(tidyLayout(junk, ["a"])).toEqual({
      order: ["F", "a"],
      folders: [{ id: "F", name: "New folder", projects: [] }],
    });
  });

  test("tidying a tidy layout changes nothing", () => {
    const once = tidyLayout(filed, ids);
    expect(sameLayout(tidyLayout(once, ids), once)).toBe(true);
  });
});

describe("moveInLayout", () => {
  test("a project to before another, and to the end", () => {
    expect(moveInLayout(flat, "d", { beforeId: "b" }).order).toEqual(["a", "d", "b", "c"]);
    expect(moveInLayout(flat, "a").order).toEqual(["b", "c", "d", "a"]);
  });

  test("into a folder, at the end or before one of its own", () => {
    expect(moveInLayout(filed, "a", { folderId: "F" })).toEqual({
      order: ["F", "d"],
      folders: [{ id: "F", name: "work", projects: ["b", "c", "a"] }],
    });
    expect(moveInLayout(filed, "d", { folderId: "F", beforeId: "c" }).folders[0]?.projects).toEqual([
      "b",
      "d",
      "c",
    ]);
  });

  test("within a folder, and out of it to the top level", () => {
    expect(moveInLayout(filed, "c", { folderId: "F", beforeId: "b" }).folders[0]?.projects).toEqual([
      "c",
      "b",
    ]);
    const out = moveInLayout(filed, "b", { beforeId: "d" });
    expect(out.order).toEqual(["a", "F", "b", "d"]);
    expect(out.folders[0]?.projects).toEqual(["c"]);
  });

  test("a folder moves along the top level with its projects, and into no folder", () => {
    const moved = moveInLayout(filed, "F", { beforeId: "a", folderId: "F" });
    expect(moved.order).toEqual(["F", "a", "d"]);
    expect(flatOrder(moved)).toEqual(["b", "c", "a", "d"]);
  });

  test("what can't be done changes nothing", () => {
    expect(moveInLayout(filed, "zz", { beforeId: "a" })).toBe(filed);
    expect(moveInLayout(filed, "a", { folderId: "gone" })).toBe(filed);
    expect(moveInLayout(filed, "a", { beforeId: "a" })).toBe(filed);
  });

  test("done twice is done once — how a window knows the server has it", () => {
    for (const [id, to] of [
      ["d", { beforeId: "a" }],
      ["a", { folderId: "F" }],
      ["b", {}],
      ["F", { beforeId: "a" }],
    ] as const) {
      const once = moveInLayout(filed, id, to);
      expect(sameLayout(moveInLayout(once, id, to), once)).toBe(true);
    }
  });
});

describe("folders", () => {
  test("a new one is empty, at the top", () => {
    expect(addFolder(flat, { id: "F", name: "  side   jobs " })).toEqual({
      order: ["F", ...ids],
      folders: [{ id: "F", name: "side jobs", projects: [] }],
    });
  });

  test("around a project it takes that project's place", () => {
    expect(addFolder(flat, { id: "F", name: "x" }, "c")).toEqual({
      order: ["a", "b", "F", "d"],
      folders: [{ id: "F", name: "x", projects: ["c"] }],
    });
  });

  test("around a project already in a folder, it stands after that folder", () => {
    const next = addFolder(filed, { id: "G", name: "y" }, "b");
    expect(next.order).toEqual(["a", "F", "G", "d"]);
    expect(next.folders).toEqual([
      { id: "F", name: "work", projects: ["c"] },
      { id: "G", name: "y", projects: ["b"] },
    ]);
  });

  test("making one twice is making it once", () => {
    const once = addFolder(flat, { id: "F", name: "x" }, "c");
    expect(addFolder(once, { id: "F", name: "x" }, "c")).toBe(once);
  });

  test("renamed, folded shut and opened again", () => {
    const shut = setFolder(filed, "F", { collapsed: true });
    expect(shut.folders[0]).toEqual({ id: "F", name: "work", collapsed: true, projects: ["b", "c"] });
    const renamed = setFolder(shut, "F", { name: " play " });
    expect(renamed.folders[0]).toEqual({ id: "F", name: "play", collapsed: true, projects: ["b", "c"] });
    // a blank name is no name: the one it had stays
    expect(setFolder(renamed, "F", { name: "  " }).folders[0]?.name).toBe("play");
    expect(sameLayout(setFolder(renamed, "F", { collapsed: false, name: "work" }), filed)).toBe(true);
    expect(setFolder(filed, "gone", { name: "x" })).toBe(filed);
  });

  test("taken away, its projects stay where it stood", () => {
    expect(removeFolder(filed, "F")).toEqual(flat);
    expect(removeFolder(flat, "F")).toBe(flat);
  });

  test("folderOf and flatOrder read it", () => {
    expect(folderOf(filed, "c")?.id).toBe("F");
    expect(folderOf(filed, "a")).toBeUndefined();
    expect(flatOrder(filed)).toEqual(ids);
  });
});

describe("firstLayout", () => {
  test("the order the sidebar used to show: starred first, then the rest", () => {
    const made = firstLayout([{ id: "a" }, { id: "b", starred: true }, { id: "c" }], () => "F");
    expect(made).toEqual({ order: ["b", "a", "c"], folders: [] });
  });

  test("a group label a project was opened under becomes a folder, where its first project stood", () => {
    let n = 0;
    const made = firstLayout(
      [{ id: "a" }, { id: "b", folder: "Work" }, { id: "c" }, { id: "d", folder: "work " }],
      () => `F${++n}`,
    );
    expect(made).toEqual({
      order: ["a", "F1", "c"],
      folders: [{ id: "F1", name: "Work", projects: ["b", "d"] }],
    });
  });
});
