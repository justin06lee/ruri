import SwiftUI
import UIKit

/// What this iPhone hears from the Mac, and when it hears it quietly.
struct NotificationsView: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.openURL) private var openURL

    private var notifications: Notifications { model.notifications }

    /// One switch or field of the settings, bound.
    private func binding<T>(_ key: WritableKeyPath<PushPrefs, T>) -> Binding<T> {
        Binding {
            notifications.prefs[keyPath: key]
        } set: { value in
            var prefs = notifications.prefs
            prefs[keyPath: key] = value
            notifications.set(prefs)
        }
    }

    /// The start of quiet hours as a time of day, for the picker.
    private var start: Binding<Date> {
        Binding {
            Calendar.current.date(
                byAdding: .minute, value: notifications.prefs.startMinute, to: Calendar.current.startOfDay(for: .now)
            ) ?? .now
        } set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            var prefs = notifications.prefs
            prefs.startMinute = (parts.hour ?? 21) * 60 + (parts.minute ?? 30)
            notifications.set(prefs)
        }
    }

    private var until: String {
        let end = notifications.tonightEnds()?.formatted(date: .omitted, time: .shortened) ?? "5:30"
        return notifications.place == nil ? end : "Fajr, \(end)"
    }

    var body: some View {
        Form {
            if notifications.allowed == .denied {
                Section {
                    Button("Turn On in Settings") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                    }
                } footer: {
                    Text("Notifications are off for ruri on this iPhone.")
                }
            }
            Section {
                Toggle("Finished", isOn: binding(\.finished))
                Toggle("Needs Input", isOn: binding(\.needsInput))
            } footer: {
                Text("When a project's work is done, or a chat asks you something.")
            }
            Section {
                Toggle("Quiet Hours", isOn: binding(\.quiet))
                if notifications.prefs.quiet {
                    DatePicker("From", selection: start, displayedComponents: .hourAndMinute)
                    LabeledContent("Until", value: until)
                    Picker("Notifications", selection: binding(\.mode)) {
                        Text("Deliver Quietly").tag(PushPrefs.Mode.silent)
                        Text("Summary at the End").tag(PushPrefs.Mode.batch)
                    }
                }
            } footer: {
                if notifications.prefs.quiet {
                    if notifications.place != nil {
                        Text("Fajr is worked out on this iPhone from your rough location (ISNA, 15°).")
                    } else if notifications.located == .denied || notifications.located == .restricted {
                        Text("Without your location, quiet hours end at 5:30.")
                    } else {
                        Button("Use Location to End at Fajr") {
                            Task {
                                await notifications.locate()
                                await notifications.sync()
                            }
                        }
                        .font(.footnote)
                    }
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await notifications.wake() }
    }
}
