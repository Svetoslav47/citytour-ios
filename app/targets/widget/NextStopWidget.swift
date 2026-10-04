// Home-screen "Next stop" card (B14, DESIGN §3.13 of the HarmonyOS app): the iOS port of the ArkTS Form Kit card
// entry/src/main/ets/widget/pages/NextStopCard.ets. The app (viewmodel/WidgetBridge.ts) writes the already
// localised card texts as JSON to the App Group defaults under "nextStopCard" and reloads the timelines:
// { overline, title, big, foot, demo: "0"|"1", mode: "idle"|"heading"|"atStop"|"complete"|"ended", simulatedLabel }.
// Tapping the card opens the app (widgetURL citytour://).
import SwiftUI
import WidgetKit

private let appGroup = "group.com.hackyeah.citytour.ios"
private let cardKey = "nextStopCard"

struct CardData: Codable {
  var overline: String = "CityTour"
  var title: String = ""
  var big: String = ""
  var foot: String = ""
  var demo: String = "0"
  var mode: String = "idle"
  var simulatedLabel: String = "SIMULATED"

  static func load() -> CardData {
    guard let defaults = UserDefaults(suiteName: appGroup),
          let text = defaults.string(forKey: cardKey),
          let data = text.data(using: .utf8),
          let card = try? JSONDecoder().decode(CardData.self, from: data) else {
      return CardData()
    }
    return card
  }
}

struct CardEntry: TimelineEntry {
  let date: Date
  let card: CardData
}

struct CardProvider: TimelineProvider {
  func placeholder(in context: Context) -> CardEntry {
    CardEntry(date: Date(), card: CardData(overline: "NEXT · 1/11", title: "Barbican", big: "320 m", foot: "CityTour"))
  }

  func getSnapshot(in context: Context, completion: @escaping (CardEntry) -> Void) {
    completion(CardEntry(date: Date(), card: CardData.load()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<CardEntry>) -> Void) {
    // The app pushes every change (WidgetCenter.reloadAllTimelines), so the widget never polls.
    completion(Timeline(entries: [CardEntry(date: Date(), card: CardData.load())], policy: .never))
  }
}

/// The shared palette (common/src/main/resources/{base,dark}/element/color.json).
private func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
  Color(UIColor { trait in
    let v = trait.userInterfaceStyle == .dark ? dark : light
    return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                   blue: CGFloat(v & 0xFF) / 255, alpha: 1)
  })
}

private let textPrimary = dyn(0x16181A, 0xECEEEF)
private let textSecondary = dyn(0x5A6066, 0xA7ADB2)
private let accent = dyn(0x1D6B5B, 0x6CC3AE)
private let surface = dyn(0xFFFFFF, 0x1A1D1F)
private let simFg = dyn(0x7A4F00, 0xF2C46B)
private let simBg = dyn(0xFFF1D6, 0x3A2C0D)

struct NextStopCardView: View {
  let card: CardData

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(card.overline)
        .font(.system(size: 12, weight: .medium))
        .kerning(0.6)
        .foregroundColor(textSecondary)
        .lineLimit(1)
      Text(card.title.isEmpty ? "CityTour" : card.title)
        .font(.system(size: 18, weight: .bold))
        .foregroundColor(textPrimary)
        .lineLimit(2)
        .padding(.top, 6)
      Spacer(minLength: 0)
      if !card.big.isEmpty {
        Text(card.big)
          .font(.system(size: 28, weight: .bold).monospacedDigit())
          .foregroundColor(textPrimary)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }
      HStack(spacing: 6) {
        if card.demo == "1" {
          Text(card.simulatedLabel)
            .font(.system(size: 9, weight: .medium))
            .foregroundColor(simFg)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(simBg)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        Text(card.foot)
          .font(.system(size: 12))
          .foregroundColor(card.mode == "idle" ? accent : textSecondary)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .environment(\.layoutDirection, .leftToRight)
    .widgetURL(URL(string: "citytour://"))
  }
}

struct NextStopWidget: Widget {
  let kind: String = "NextStopWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: CardProvider()) { entry in
      NextStopCardView(card: entry.card)
        .containerBackground(surface, for: .widget)
    }
    .configurationDisplayName("CityTour")
    .description("Next stop of your walk.")
    .supportedFamilies([.systemSmall])
  }
}

@main
struct CityTourWidgetBundle: WidgetBundle {
  var body: some Widget {
    NextStopWidget()
  }
}
