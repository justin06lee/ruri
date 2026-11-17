import SwiftUI
import UniformTypeIdentifiers

/// The projects as the Mac's sidebar arranges them: in its order, in its
/// folders — which fold and open — and starred where it stars them.
///
/// Each row has a handle on its right: held, it lifts the row, which then
/// goes before whichever row it is dropped on (into that row's folder),
/// into a folder dropped on its name, or to the end below the last. Only
/// the handle carries a row, so a scroll or a tap never moves one. Every
/// move and fold goes to the Mac too, and its windows follow.
struct SidebarList: View {
    var report: StatusReport
    @Environment(RuriModel.self) private var model

    enum Entry: Identifiable {
        case folder(SidebarLayout.Folder, [StatusProject])
        /// A project, and the folder it is in.
        case project(StatusProject, String?)

        var id: String {
            switch self {
            case .folder(let folder, _): "folder:\(folder.id)"
            case .project(let project, _): "project:\(project.macId ?? project.name)"
            }
        }
    }

    /// The rows, top to bottom: a folded folder's projects are out of sight.
    /// A project the layout doesn't place goes at the end.
    static func entries(_ report: StatusReport, _ layout: SidebarLayout) -> [Entry] {
        var byId: [String: StatusProject] = [:]
        for project in report.projects { if let id = project.macId { byId[id] = project } }
        var placed = Set<String>()
        var entries: [Entry] = []
        for id in layout.order {
            if let folder = layout.folder(id) {
                let inside = folder.projects.compactMap { byId[$0] }
                entries.append(.folder(folder, inside))
                if folder.collapsed != true { entries += inside.map { .project($0, folder.id) } }
                placed.formUnion(folder.projects)
            } else if let project = byId[id] {
                entries.append(.project(project, nil))
                placed.insert(id)
            }
        }
        for project in report.projects where !(project.macId.map(placed.contains) ?? false) {
            entries.append(.project(project, nil))
        }
        return entries
    }

    var body: some View {
        if let layout = report.sidebar {
            VStack(spacing: 0) {
                RowSection(title: "Projects") {
                    ForEach(Self.entries(report, layout)) { entry in
                        switch entry {
                        case .folder(let folder, let inside):
                            FolderRow(folder: folder, inside: inside) {
                                model.fold(folder.id, folder.collapsed != true)
                            }
                            .droppable(fill: true) { dropped($0, onFolder: folder.id, layout) }
                            .overlay(alignment: .trailing) { handle(folder.id, folder.name, layout) }
                        case .project(let project, let folder):
                            row(project, indented: folder != nil)
                                .droppable { dropped($0, before: project.macId, in: folder, layout) }
                                .overlay(alignment: .trailing) {
                                    if let id = project.macId { handle(id, project.name, layout) }
                                }
                        }
                    }
                }
                // below the last row: the end of the list
                Color.clear
                    .frame(height: 36)
                    .droppable { id in model.move(id, into: nil, before: nil) }
            }
        } else {
            // a Mac from before the phone was told its sidebar
            RowSection(title: "Projects") {
                ForEach(report.projects) { project in row(project, indented: false) }
            }
        }
    }

    private func row(_ project: StatusProject, indented: Bool) -> some View {
        NavigationLink(value: Destination.project(project)) {
            ProjectRow(project: project, indented: indented)
                // room for the handle over the row's right edge
                .padding(.trailing, report.sidebar == nil ? 0 : 30)
        }
        .buttonStyle(RowPress())
        .accessibilityIdentifier("project.\(project.name)")
    }

    private func handle(_ id: String, _ name: String, _ layout: SidebarLayout) -> some View {
        DragHandle(id: id, name: name)
            .accessibilityAction(named: "Move Up") { shift(id, up: true, layout) }
            .accessibilityAction(named: "Move Down") { shift(id, up: false, layout) }
    }

    // MARK: where a drop puts things

    /// Dropped on a project's row: before it, in its folder. A folder
    /// carried there goes before that folder instead — folders never nest.
    private func dropped(_ id: String, before target: String?, in folder: String?, _ layout: SidebarLayout) {
        guard let target else { return }
        if layout.folder(id) != nil {
            model.move(id, into: nil, before: folder ?? target)
        } else {
            model.move(id, into: folder, before: target)
        }
    }

    /// Dropped on a folder's name: a project goes in, at its end; a folder
    /// goes before it.
    private func dropped(_ id: String, onFolder folder: String, _ layout: SidebarLayout) {
        if layout.folder(id) != nil {
            model.move(id, into: nil, before: folder)
        } else {
            model.move(id, into: folder, before: nil)
        }
    }

    /// One place up or down among its neighbours. A project at the top or
    /// the bottom of its folder steps out of it, just above or below.
    private func shift(_ id: String, up: Bool, _ layout: SidebarLayout) {
        let folder = layout.folder(holding: id)?.id
        let list = folder.flatMap { layout.folder($0)?.projects } ?? layout.order
        guard let at = list.firstIndex(of: id) else { return }
        let after = { (list: [String], at: Int) in at + 1 < list.count ? list[at + 1] : nil }
        if up {
            if at > 0 {
                model.move(id, into: folder, before: list[at - 1])
            } else if let folder {
                model.move(id, into: nil, before: folder)
            }
        } else if at + 1 < list.count {
            model.move(id, into: folder, before: after(list, at + 1))
        } else if let folder, let place = layout.order.firstIndex(of: folder) {
            model.move(id, into: nil, before: after(layout.order, place))
        }
    }
}

/// A folder in the list: a tap folds or opens it. Folded, it still says how
/// many projects are in it, and whether any is at work or waiting on you.
private struct FolderRow: View {
    var folder: SidebarLayout.Folder
    var inside: [StatusProject]
    var toggle: () -> Void
    @Environment(\.palette) private var palette

    private var folded: Bool { folder.collapsed == true }

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 10) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(palette.inkSoft)
                    .rotationEffect(.degrees(folded ? 0 : 90))
                    .frame(width: 20, height: 22)
                Text(folder.name)
                    .font(.ruri(.body, .medium))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if folded {
                    if inside.contains(where: { $0.state == .needsYou }) {
                        StateGlyph(state: .needsYou)
                    } else if inside.contains(where: { $0.state == .working }) {
                        StateGlyph(state: .working)
                    }
                }
                Text("\(inside.count)")
                    .font(.ruri(.footnote))
                    .foregroundStyle(palette.inkFaint)
                    .monospacedDigit()
            }
            .padding(.leading, 10)
            .padding(.trailing, 44)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(RowPress())
        .animation(.snappy(duration: 0.2), value: folded)
        .accessibilityLabel("\(folder.name), folder, \(inside.count) \(inside.count == 1 ? "project" : "projects")")
        .accessibilityValue(folded ? "folded" : "open")
        .accessibilityIdentifier("folder.\(folder.name)")
    }
}

/// The grip on a row's right: the only place a row can be lifted from.
private struct DragHandle: View {
    var id: String
    var name: String
    @Environment(\.palette) private var palette

    var body: some View {
        Image(systemName: "line.3.horizontal")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(palette.inkFaint)
            .frame(width: 40, height: 44)
            .contentShape(.rect)
            .onDrag {
                NSItemProvider(object: id as NSString)
            } preview: {
                Text(name)
                    .font(.ruri(.body, .medium))
                    .foregroundStyle(palette.ink)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(palette.raised, in: .capsule)
            }
            .accessibilityLabel("Move \(name)")
            .accessibilityHint("Drag to put it somewhere else in the sidebar.")
            .accessibilityIdentifier("handle.\(name)")
    }
}

extension View {
    /// Somewhere a carried row can be dropped: marked with a line along its
    /// top while one is over it — or, for a folder (`fill`), washed over,
    /// since what is dropped there goes in.
    func droppable(fill: Bool = false, _ drop: @escaping (String) -> Void) -> some View {
        modifier(Droppable(fill: fill, drop: drop))
    }
}

private struct Droppable: ViewModifier {
    var fill: Bool
    var drop: (String) -> Void
    @Environment(\.palette) private var palette
    @State private var over = false

    func body(content: Content) -> some View {
        content
            .background { if over, fill { palette.fill } }
            .overlay(alignment: .top) {
                if over, !fill {
                    palette.accent
                        .frame(height: 2)
                        .padding(.horizontal, 8)
                }
            }
            .onDrop(of: [.plainText, .text], isTargeted: $over) { providers in
                guard let provider = providers.first else { return false }
                _ = provider.loadObject(ofClass: NSString.self) { item, _ in
                    guard let id = item as? NSString else { return }
                    let text = String(id)
                    Task { @MainActor in drop(text) }
                }
                return true
            }
    }
}
