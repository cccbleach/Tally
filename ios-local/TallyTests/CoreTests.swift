//
//  CoreTests.swift
//  TallyTests
//
//  Tests for money, currency parsing and date/period handling.
//

import Testing
import Foundation
@testable import Tally

@Suite("Money & Currency")
struct MoneyTests {

    @Test("Money stores integer minor units and formats")
    func moneyFormatting() {
        let money = Money(minorUnits: 1250, currencyCode: "CNY")
        #expect(money.amount == Decimal(12.50))
        #expect(money.formatted == "¥12.50")
        #expect(money.decimalString == "12.50")
    }

    @Test("Money addition and comparison")
    func moneyArithmetic() {
        let a = Money(minorUnits: 100, currencyCode: "CNY")
        let b = Money(minorUnits: 250, currencyCode: "CNY")
        #expect(a + b == Money(minorUnits: 350, currencyCode: "CNY"))
        #expect(b - a == Money(minorUnits: 150, currencyCode: "CNY"))
        #expect(a < b)
        #expect((-a).minorUnits == -100)
    }

    @Test("CNY parses decimal strings to minor units")
    func cnyParsing() {
        let info = Currencies.info(forCode: "CNY")
        #expect(info.minorUnits(fromString: "12.5") == 1250)
        #expect(info.minorUnits(fromString: "12.50") == 1250)
        #expect(info.minorUnits(fromString: "0.01") == 1)
        #expect(info.minorUnits(fromString: "100") == 10000)
        #expect(info.minorUnits(fromString: "12.345") == nil)
        #expect(info.minorUnits(fromString: "abc") == nil)
    }

    @Test("JPY uses zero minor units")
    func jpyParsing() {
        let info = Currencies.info(forCode: "JPY")
        #expect(info.minorUnits == 0)
        #expect(info.minorUnits(fromString: "100") == 100)
        #expect(info.minorUnits(fromString: "100.5") == nil)
        #expect(info.string(fromMinorUnits: 100) == "100")
    }

    @Test("String conversion round trips through minor units")
    func roundTrip() {
        let info = Currencies.info(forCode: "CNY")
        for value in ["0.01", "1.00", "12.50", "9999.99"] {
            if let minor = info.minorUnits(fromString: value) {
                #expect(info.string(fromMinorUnits: minor) == value)
            } else {
                Issue.record("failed to parse \(value)")
            }
        }
    }

    @Test("Negative amount handling")
    func negativeMoney() {
        let info = Currencies.info(forCode: "CNY")
        #expect(info.minorUnits(fromString: "-12.50") == -1250)
        #expect(info.minorUnits(fromString: "-0.50") == -50)
        #expect(info.string(fromMinorUnits: -1250) == "-12.50")
        #expect(info.minorUnits(fromString: "12,50") == 1250)
        #expect(info.minorUnits(fromString: "1,234.56") == 123456)
    }

    @Test("Overflow is rejected and Int64 minimum formats safely")
    func overflowBoundaries() {
        let info = Currencies.info(forCode: "CNY")
        #expect(info.minorUnits(fromString: "92233720368547758.07") == Int64.max)
        #expect(info.minorUnits(fromString: "92233720368547758.08") == nil)
        #expect(info.minorUnits(fromString: "-92233720368547758.08") == Int64.min)
        #expect(info.string(fromMinorUnits: Int64.min) == "-92233720368547758.08")
    }

    @Test("Unknown currency never silently becomes CNY")
    func unknownCurrency() {
        #expect(Currencies.supportedInfo(forCode: "ABC") == nil)
        #expect(Currencies.info(forCode: "ABC").code == "ABC")
        #expect(Currencies.info(forCode: "ABC").symbol == "ABC ")
    }
}

@Suite("Date & Month Periods")
struct DateRangeTests {

    @Test("Standard month period contains its dates")
    func standardPeriod() {
        let calendar = Calendar(identifier: .gregorian)
        let comps = DateComponents(year: 2026, month: 8, day: 15)
        let date = calendar.date(from: comps)!
        let period = MonthPeriod(year: 2026, month: 8)
        #expect(period.contains(date, calendar: calendar))
        #expect(calendar.component(.day, from: period.startDate(calendar: calendar)) == 1)
        #expect(calendar.component(.day, from: period.endDate(calendar: calendar)) == 1)
        #expect(calendar.component(.month, from: period.endDate(calendar: calendar)) == 9)
    }

    @Test("Custom month start shifts the period boundary")
    func customStart() {
        let calendar = Calendar(identifier: .gregorian)

        // With start on the 1st, the 28th belongs to the same calendar month.
        let d1 = DateComponents(year: 2026, month: 8, day: 28)
        let date1 = calendar.date(from: d1)!
        #expect(MonthPeriod.containing(date1, dayStartsOn: 1, calendar: calendar) == MonthPeriod(year: 2026, month: 8))

        // With start on the 20th, 2026-08-28 belongs to the period starting 2026-08-20,
        // i.e. published month = 8.
        #expect(MonthPeriod.containing(date1, dayStartsOn: 20, calendar: calendar) == MonthPeriod(year: 2026, month: 8, dayStartsOn: 20))

        // 2026-08-10 is before the 20th, so it belongs to the period starting 2026-07-20
        // (calendar month 7).
        let d2 = DateComponents(year: 2026, month: 8, day: 10)
        let date2 = calendar.date(from: d2)!
        #expect(MonthPeriod.containing(date2, dayStartsOn: 20, calendar: calendar) == MonthPeriod(year: 2026, month: 7, dayStartsOn: 20))
    }

    @Test("Period shifting and listing")
    func shifting() {
        let p = MonthPeriod(year: 2026, month: 8, dayStartsOn: 1)
        #expect(p.next == MonthPeriod(year: 2026, month: 9))
        #expect(p.previous == MonthPeriod(year: 2026, month: 7))
        #expect(p.shifted(by: -1) == MonthPeriod(year: 2026, month: 7))
        #expect(p.shifted(by: 5) == MonthPeriod(year: 2027, month: 1))
        let all = DateRange.periods(from: MonthPeriod(year: 2026, month: 6), through: MonthPeriod(year: 2026, month: 8))
        #expect(all.map(\.month) == [6, 7, 8])
    }

    @Test("Start days 29 through 31 clamp to short months")
    func shortMonthClamping() {
        let calendar = Calendar(identifier: .gregorian)
        let february = MonthPeriod(year: 2026, month: 2, dayStartsOn: 31)
        let leapFebruary = MonthPeriod(year: 2028, month: 2, dayStartsOn: 31)
        #expect(calendar.component(.day, from: february.startDate(calendar: calendar)) == 28)
        #expect(calendar.component(.day, from: leapFebruary.startDate(calendar: calendar)) == 29)

        let before = calendar.date(from: DateComponents(year: 2026, month: 2, day: 27, hour: 12))!
        let boundary = calendar.date(from: DateComponents(year: 2026, month: 2, day: 28, hour: 12))!
        #expect(MonthPeriod.containing(before, dayStartsOn: 31, calendar: calendar) == MonthPeriod(year: 2026, month: 1, dayStartsOn: 31))
        #expect(MonthPeriod.containing(boundary, dayStartsOn: 31, calendar: calendar) == february)
        #expect(calendar.component(.day, from: february.endDate(calendar: calendar)) == 31)
        #expect(calendar.component(.month, from: february.endDate(calendar: calendar)) == 3)
    }
}

@Suite("Privacy Lock State")
struct AppStateTests {
    @Test("Failed authentication never unlocks")
    func failedAuthentication() {
        let state = AppState(isLocked: true)
        state.handleAuthenticationResult(false)
        #expect(state.isLocked)
        state.handleAuthenticationResult(true)
        #expect(!state.isLocked)
    }

    @Test("Background relock only applies when enabled")
    func relock() {
        let state = AppState(isLocked: false)
        state.lockIfNeeded(isEnabled: false)
        #expect(!state.isLocked)
        state.lockIfNeeded(isEnabled: true)
        #expect(state.isLocked)
    }

    @Test("Re-enabling biometric lock after disable immediately locks even when already unlocked")
    func reenableImmediatelyLocks() {
        let state = AppState(isLocked: false)
        state.handleBiometricSettingChange(wasEnabled: false, isEnabled: true)
        #expect(state.isLocked)
    }

    @Test("Disabling biometric lock does not auto-unlock or auto-lock")
    func disableKeepsState() {
        let unlocked = AppState(isLocked: false)
        unlocked.handleBiometricSettingChange(wasEnabled: true, isEnabled: false)
        #expect(!unlocked.isLocked)

        let locked = AppState(isLocked: true)
        locked.handleBiometricSettingChange(wasEnabled: true, isEnabled: false)
        #expect(locked.isLocked)
    }

    @Test("Re-enabling after successful authentication locks again")
    func reenableAfterSuccessfulAuthenticationLocks() {
        let state = AppState(isLocked: true)
        state.handleAuthenticationResult(true)
        #expect(!state.isLocked)
        state.handleBiometricSettingChange(wasEnabled: false, isEnabled: true)
        #expect(state.isLocked)
    }
}

@Suite("Privacy First-Frame Route")
struct RootRouteTests {

    @Test("Settings not loaded yet routes to loading, never main")
    func settingsNotLoaded() {
        #expect(RootRouteResolver.route(settingsLoaded: false, hasCompletedOnboarding: false, biometricLockEnabled: false, isLocked: true) == .loading)
        #expect(RootRouteResolver.route(settingsLoaded: false, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: false) == .loading)
    }

    @Test("Onboarding not completed routes to onboarding")
    func onboarding() {
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: false, biometricLockEnabled: false, isLocked: false) == .onboarding)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: false, biometricLockEnabled: true, isLocked: true) == .onboarding)
    }

    @Test("Completed onboarding + biometric enabled + locked routes to locked")
    func locked() {
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: true) == .locked)
    }

    @Test("Failed authentication keeps the app locked")
    func failedAuthenticationStaysLocked() {
        let state = AppState(isLocked: true)
        state.handleAuthenticationResult(false)
        #expect(state.isLocked)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: state.isLocked) == .locked)
    }

    @Test("Successful authentication routes to main")
    func successfulAuthenticationGoesMain() {
        let state = AppState(isLocked: true)
        state.handleAuthenticationResult(true)
        #expect(!state.isLocked)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: state.isLocked) == .main)
    }

    @Test("Biometric disabled routes straight to main")
    func biometricDisabledGoesMain() {
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: false, isLocked: true) == .main)
    }

    @Test("Inactive or background phase relocks when biometric enabled")
    func backgroundRelocks() {
        let state = AppState(isLocked: false)
        state.lockIfNeeded(isEnabled: true)
        #expect(state.isLocked)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: state.isLocked) == .locked)
    }

    @Test("Settings loading from nil into a needing-lock state never passes through main")
    func noMainFlashBetweenNilAndLocked() {
        // While settings are not loaded the route must be loading.
        #expect(RootRouteResolver.route(settingsLoaded: false, hasCompletedOnboarding: false, biometricLockEnabled: false, isLocked: true) == .loading)
        // The very next state (loaded, completed, biometric enabled, still locked)
        // must be locked — main may never appear in between.
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: true) == .locked)
    }

    @Test("Re-enabling biometric lock routes straight to locked without showing main")
    func reenableRoutesToLocked() {
        let state = AppState(isLocked: false)
        state.handleBiometricSettingChange(wasEnabled: false, isEnabled: true)
        #expect(state.isLocked)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: state.isLocked) == .locked)
    }

    @Test("Disabling biometric lock shows main and a later re-enable locks again")
    func disableGoesMainThenReenableLocks() {
        let state = AppState(isLocked: true)
        state.handleBiometricSettingChange(wasEnabled: true, isEnabled: false)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: false, isLocked: state.isLocked) == .main)
        // A later re-enable in the same foreground session locks immediately.
        state.handleBiometricSettingChange(wasEnabled: false, isEnabled: true)
        #expect(state.isLocked)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: state.isLocked) == .locked)
    }

    @Test("Failed authentication after re-enable stays locked")
    func failedAuthAfterReenableStaysLocked() {
        let state = AppState(isLocked: false)
        state.handleBiometricSettingChange(wasEnabled: false, isEnabled: true)
        state.handleAuthenticationResult(false)
        #expect(state.isLocked)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: state.isLocked) == .locked)
    }

    @Test("Successful authentication after re-enable returns to main")
    func successfulAuthAfterReenableGoesMain() {
        let state = AppState(isLocked: false)
        state.handleBiometricSettingChange(wasEnabled: false, isEnabled: true)
        #expect(state.isLocked)
        state.handleAuthenticationResult(true)
        #expect(!state.isLocked)
        #expect(RootRouteResolver.route(settingsLoaded: true, hasCompletedOnboarding: true, biometricLockEnabled: true, isLocked: state.isLocked) == .main)
    }
}
