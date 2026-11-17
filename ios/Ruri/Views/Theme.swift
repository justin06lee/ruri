import CoreText
import SwiftUI
import UIKit

// ruri's look, as the Mac draws it (web/src/styles.css): three quiet themes
// — light, dark and ember — in paper and ink, one typeface, and surfaces told
// apart by shade rather than by a line drawn round them.

/// One theme's colours. The names are the Mac's tokens.
struct Palette: Equatable, Sendable {
    /// The page a conversation is read on.
    var paper: Color
    /// A shade off the page: a chip, a code block, a card on the page.
    var paperDim: Color
    /// The home screen's ground, as the Mac's sidebar is a shade off its page.
    var ground: Color
    /// A card on the ground, and the field a prompt is written in.
    var raised: Color
    var ink: Color
    var inkSoft: Color
    var inkFaint: Color
    /// The user's own bubble: Messages' grey, not the blue.
    var bubble: Color
    /// A wash of ink: a pressed row, a quiet button.
    var fill: Color
    var hairline: Color
    var accent: Color
    var destructive: Color
    var dark: Bool

    static let light = Palette(
        paper: Color(hex: 0xFFFFFF), paperDim: Color(hex: 0xF5F5F5), ground: Color(hex: 0xF0F0F2),
        raised: Color(hex: 0xFFFFFF), ink: Color(hex: 0x1D1D1F), inkSoft: Color(hex: 0x636366),
        inkFaint: Color(hex: 0x76767B), bubble: Color(hex: 0xEDEDED),
        fill: Color(hex: 0x1D1D1F).opacity(0.08), hairline: Color(hex: 0x0A0A0B).opacity(0.08),
        accent: Color(hex: 0x007AFF), destructive: Color(hex: 0xD70015), dark: false
    )

    static let dark = Palette(
        paper: Color(hex: 0x0C0C0C), paperDim: Color(hex: 0x161616), ground: Color(hex: 0x0C0C0C),
        raised: Color(hex: 0x1C1C1C), ink: Color(hex: 0xEDEDED), inkSoft: Color(hex: 0xB3B3B3),
        inkFaint: Color(hex: 0x8A8A8A), bubble: Color(hex: 0x2D2D2D),
        fill: Color(hex: 0xEDEDED).opacity(0.1), hairline: Color.white.opacity(0.08),
        accent: Color(hex: 0x0A84FF), destructive: Color(hex: 0xFF6961), dark: true
    )

    /// A warm dark for late hours: brown-black surfaces and parchment ink.
    static let ember = Palette(
        paper: Color(hex: 0x0F0B08), paperDim: Color(hex: 0x17120E), ground: Color(hex: 0x0F0B08),
        raised: Color(hex: 0x211A15), ink: Color(hex: 0xF1E4D2), inkSoft: Color(hex: 0xB9A68F),
        inkFaint: Color(hex: 0x7F6F5D), bubble: Color(hex: 0x322A24),
        fill: Color(hex: 0xF1E4D2).opacity(0.1), hairline: Color(hex: 0xF1E4D2).opacity(0.08),
        accent: Color(hex: 0x0A84FF), destructive: Color(hex: 0xFF6961), dark: true
    )
}

/// Which theme the app wears.
enum Appearance: String, CaseIterable, Identifiable, Sendable {
    /// Light or dark, as the iPhone is.
    case system
    case light
    case dark
    case ember

    static let key = "appearance"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "Automatic"
        case .light: "Light"
        case .dark: "Dark"
        case .ember: "Ember"
        }
    }

    /// What the system's own surfaces — sheets, menus, the keyboard — are
    /// asked to wear; nil follows the iPhone.
    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark, .ember: .dark
        }
    }

    func palette(_ scheme: ColorScheme) -> Palette {
        switch self {
        case .system: scheme == .dark ? .dark : .light
        case .light: .light
        case .dark: .dark
        case .ember: .ember
        }
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.light
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255, opacity: 1
        )
    }
}

/// Dresses everything under it in the chosen theme: the palette, the
/// typeface and the tint.
struct Themed: ViewModifier {
    @AppStorage(Appearance.key) private var appearance = Appearance.system
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let palette = appearance.palette(scheme)
        content
            .environment(\.palette, palette)
            .environment(\.font, .ruri(.body))
            .foregroundStyle(palette.ink)
            .tint(palette.accent)
            .preferredColorScheme(appearance.scheme)
    }
}

extension View {
    func themed() -> some View { modifier(Themed()) }
}

// MARK: type

/// Space Grotesk, the Mac's typeface, in the weights it ships in.
enum Typeface {
    enum Weight: String {
        case regular = "SpaceGrotesk-Regular"
        case medium = "SpaceGrotesk-Medium"
        case bold = "SpaceGrotesk-Bold"
    }

    /// Make the fonts in the bundle known, and give the bars the typeface.
    /// Without the files, everything falls back to the system's font.
    @MainActor
    static func register() {
        for url in Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [] {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        let bar = UINavigationBar.appearance()
        if let title = UIFont(name: Weight.bold.rawValue, size: 17) {
            bar.titleTextAttributes = [.font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: title)]
        }
        if let large = UIFont(name: Weight.bold.rawValue, size: 32) {
            bar.largeTitleTextAttributes = [.font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: large)]
        }
    }

    /// The point size each text style is set at before Dynamic Type scales it.
    static func size(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 32
        case .title: 26
        case .title2: 21
        case .title3: 19
        case .headline, .body: 16
        case .callout: 15
        case .subheadline: 14
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        default: 16
        }
    }

    /// The same face for UIKit: the field a prompt is written in.
    @MainActor
    static func uiFont(_ style: UIFont.TextStyle, size: CGFloat, _ weight: Weight = .regular) -> UIFont {
        let base = UIFont(name: weight.rawValue, size: size) ?? .systemFont(ofSize: size)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: base)
    }
}

extension Font {
    /// ruri's typeface at a text style's size, scaling with Dynamic Type.
    static func ruri(_ style: Font.TextStyle, _ weight: Typeface.Weight = .regular) -> Font {
        .custom(weight.rawValue, size: Typeface.size(style), relativeTo: style)
    }

    /// For what is code: a path, a command, a step.
    static func ruriMono(_ style: Font.TextStyle) -> Font {
        .system(size: Typeface.size(style) - 1, design: .monospaced)
    }
}

// MARK: surfaces

extension View {
    /// A card: a rounded surface a shade off what it stands on, no line
    /// round it.
    func card(_ fill: Color, radius: CGFloat = 18) -> some View {
        background(fill, in: .rect(cornerRadius: radius, style: .continuous))
    }

    /// The small label over a group of rows.
    func sectionLabel(_ palette: Palette) -> some View {
        font(.ruri(.footnote, .medium))
            .foregroundStyle(palette.inkSoft)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
    }
}

/// A row that darkens under the finger, as the Mac's do under the pointer.
struct RowPress: ButtonStyle {
    @Environment(\.palette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(.rect)
            .background(configuration.isPressed ? palette.fill : .clear)
    }
}

/// The one filled button on a screen.
struct PrimaryButton: ButtonStyle {
    @Environment(\.palette) private var palette
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.ruri(.body, .medium))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(palette.accent, in: .capsule)
            .opacity(configuration.isPressed ? 0.75 : enabled ? 1 : 0.4)
    }
}

/// A quiet button beside it: a wash of ink.
struct QuietButton: ButtonStyle {
    @Environment(\.palette) private var palette

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.ruri(.body, .medium))
            .foregroundStyle(palette.ink)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(palette.fill, in: .capsule)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
