import SwiftUI
import UIKit

/// The field a prompt is written in: UIKit's own text view, grown to fit
/// its lines up to a height and scrolling past it.
///
/// It is UIKit's rather than SwiftUI's so that what a finger expects of a
/// text field is simply there — the caret, selection, and the menu that
/// pastes — whatever the screen around it is doing: a chat redraws several
/// times a second while a reply is being written. A picture or a file on the
/// pasteboard pastes too, as an attachment.
struct PromptField: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var palette: Palette
    /// The tallest it grows before its text scrolls inside it.
    var maxHeight: CGFloat = 148
    /// Whether the caret is in it.
    @Binding var editing: Bool
    /// Pictures or files pasted in.
    var pasted: ([NSItemProvider]) -> Void = { _ in }
    /// ⌘↩ on a keyboard: send.
    var submit: () -> Void = {}

    func makeUIView(context: Context) -> PromptTextView {
        let view = PromptTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = Typeface.uiFont(.body, size: 16)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.showsVerticalScrollIndicator = false
        view.autocapitalizationType = .sentences
        // a prompt is as often code or a path as prose
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.dataDetectorTypes = []
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityIdentifier = "chat.field"
        view.hint.font = view.font
        view.hint.adjustsFontForContentSizeCategory = true
        return view
    }

    func updateUIView(_ view: PromptTextView, context: Context) {
        context.coordinator.parent = self
        view.pasteFiles = pasted
        view.submit = submit
        // only when it differs: setting it moves the caret, and would break
        // a character still being composed
        if view.text != text {
            view.text = text
            view.invalidateIntrinsicContentSize()
        }
        view.textColor = UIColor(palette.ink)
        view.tintColor = UIColor(palette.accent)
        view.hint.text = placeholder
        view.hint.textColor = UIColor(palette.inkFaint)
        view.hint.isHidden = !view.text.isEmpty
        view.accessibilityLabel = placeholder
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PromptTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        let fit = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let scrolls = fit > maxHeight
        if view.isScrollEnabled != scrolls { view.isScrollEnabled = scrolls }
        return CGSize(width: width, height: min(fit, maxHeight))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PromptField

        init(_ parent: PromptField) { self.parent = parent }

        func textViewDidChange(_ view: UITextView) {
            (view as? PromptTextView)?.hint.isHidden = !view.text.isEmpty
            if parent.text != view.text { parent.text = view.text }
            view.invalidateIntrinsicContentSize()
        }

        func textViewDidBeginEditing(_ view: UITextView) {
            if !parent.editing { parent.editing = true }
        }

        func textViewDidEndEditing(_ view: UITextView) {
            if parent.editing { parent.editing = false }
        }
    }
}

/// The text view itself: its placeholder, and a paste that takes pictures.
final class PromptTextView: UITextView {
    let hint = UILabel()
    var pasteFiles: ([NSItemProvider]) -> Void = { _ in }
    var submit: () -> Void = {}

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        hint.numberOfLines = 1
        hint.isUserInteractionEnabled = false
        hint.isAccessibilityElement = false
        addSubview(hint)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("made in code") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let inset = textContainerInset
        let width = bounds.width - inset.left - inset.right
        hint.frame = CGRect(
            x: inset.left, y: inset.top, width: max(0, width), height: hint.sizeThatFits(.zero).height
        )
    }

    /// Words paste as ever. With none on the pasteboard, a picture or a
    /// file there is attached instead.
    private var pastesFiles: Bool {
        let board = UIPasteboard.general
        return !board.hasStrings && !board.hasURLs && board.numberOfItems > 0
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), pastesFiles { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        if pastesFiles {
            pasteFiles(UIPasteboard.general.itemProviders)
        } else {
            super.paste(sender)
        }
    }

    override var keyCommands: [UIKeyCommand]? {
        let send = UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(sendFromKeyboard))
        send.wantsPriorityOverSystemBehavior = true
        return (super.keyCommands ?? []) + [send]
    }

    @objc private func sendFromKeyboard() { submit() }
}
