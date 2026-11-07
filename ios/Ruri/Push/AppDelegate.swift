import Observation
import UIKit
import UserNotifications

/// Asks iOS for this phone's push token once a launch, and hears the
/// notifications: one tapped opens its project.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        PushLaunch.shared.registerOnce { application.registerForRemoteNotifications() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // only compared and handed on: never a reason to register again
        Task { await PushRegistrar.shared.received(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        // the next launch asks again
    }

    // the completion-handler forms, finished on the main thread: the async
    // ones finish elsewhere, and UIKit aborts on a tap (an assertion in its
    // state restoration)
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        let project = response.notification.request.content.userInfo["project"] as? String
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if let project { Opener.shared.project = project }
            }
            completionHandler()
        }
    }
}

/// A project a tapped notification asks to open; home opens it and clears it.
@MainActor
@Observable
final class Opener {
    static let shared = Opener()
    var project: String?
}
