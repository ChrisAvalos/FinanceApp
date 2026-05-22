/**
 * App entry — wires up the QueryClient + tab navigation.
 *
 * Two-tier nav (28 screens total):
 *   • Bottom bar: 5 morning-check primaries (Money, Worth, Cash,
 *     Budget, Credit) + a "More" pseudo-tab.
 *   • "More" grid: 23 secondary screens grouped into Opportunities,
 *     Tracking, Analytics, and System.
 *
 * Reasoning: 28 tabs in a horizontal scroller is unusable on a
 * phone — anything past the first 5 is invisible until the user
 * starts swiping the bar. Promoting the daily-glance surfaces and
 * stashing the rest behind a single tap is more like how
 * native iOS apps with this many surfaces handle it (e.g. Mint, Copilot).
 */
import React from "react";
import { SafeAreaView, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import TabNavigator, { TabDef, TabSection } from "./src/navigation/TabNavigator";
import AnomalyScreen from "./src/screens/AnomalyScreen";
import AttributionScreen from "./src/screens/AttributionScreen";
import BenefitsScreen from "./src/screens/BenefitsScreen";
import BudgetsScreen from "./src/screens/BudgetsScreen";
import CanonicalProductsScreen from "./src/screens/CanonicalProductsScreen";
import CardAppsScreen from "./src/screens/CardAppsScreen";
import CashFlowScreen from "./src/screens/CashFlowScreen";
import ClaimsScreen from "./src/screens/ClaimsScreen";
import ConnectionsScreen from "./src/screens/ConnectionsScreen";
import CreditScreen from "./src/screens/CreditScreen";
import DealsScreen from "./src/screens/DealsScreen";
import FireScreen from "./src/screens/FireScreen";
import GoalsScreen from "./src/screens/GoalsScreen";
import HeatmapScreen from "./src/screens/HeatmapScreen";
import HoldingsScreen from "./src/screens/HoldingsScreen";
import HsaScreen from "./src/screens/HsaScreen";
import MerchantsScreen from "./src/screens/MerchantsScreen";
import MoneyOnTableScreen from "./src/screens/MoneyOnTableScreen";
import NetWorthScreen from "./src/screens/NetWorthScreen";
import NotificationsScreen from "./src/screens/NotificationsScreen";
import OffersScreen from "./src/screens/OffersScreen";
import ReceiptsScreen from "./src/screens/ReceiptsScreen";
import RedressScreen from "./src/screens/RedressScreen";
import ShoppingPatternsScreen from "./src/screens/ShoppingPatternsScreen";
import SubscriptionsScreen from "./src/screens/SubscriptionsScreen";
import TaxScreen from "./src/screens/TaxScreen";
import TransactionsScreen from "./src/screens/TransactionsScreen";
import TrendsScreen from "./src/screens/TrendsScreen";
import UnclaimedScreen from "./src/screens/UnclaimedScreen";
import YieldOptScreen from "./src/screens/YieldOptScreen";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Phone screens are checked frequently — keep data fresh-feeling but
      // don't hammer the backend on every focus event. Web uses 60s
      // staleTime; mobile is shorter (30s) because users check the app
      // in tight bursts and a 1-minute cache misses too many in-app
      // updates. The web-aligned `gcTime` keeps cached data around for
      // 10 minutes after the last subscriber unmounts so navigating
      // back to a screen feels instant — critical on phones where
      // stack-based nav re-mounts screens often.
      staleTime: 30_000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// 5 primary tabs — these are what shows in the bottom bar and represent
// the "I open the app to check this" surfaces.
const PRIMARY_TABS: TabDef[] = [
  { key: "money", label: "Money", icon: "💰", render: () => <MoneyOnTableScreen /> },
  { key: "networth", label: "Worth", icon: "📈", render: () => <NetWorthScreen /> },
  { key: "cashflow", label: "Cash", icon: "💵", render: () => <CashFlowScreen /> },
  { key: "budgets", label: "Budget", icon: "🎯", render: () => <BudgetsScreen /> },
  { key: "credit", label: "Credit", icon: "💳", render: () => <CreditScreen /> },
];

// 23 secondary tabs, grouped by purpose. These appear in the "More" grid.
// Order within each section is rough usefulness — most-likely-to-tap first.
const MORE_SECTIONS: TabSection[] = [
  {
    title: "Opportunities",
    items: [
      { key: "offers", label: "Offers", icon: "🎁", render: () => <OffersScreen /> },
      { key: "claims", label: "Claims", icon: "⚖️", render: () => <ClaimsScreen /> },
      { key: "redress", label: "Redress", icon: "🏛️", render: () => <RedressScreen /> },
      { key: "unclaimed", label: "Unclaimed", icon: "💸", render: () => <UnclaimedScreen /> },
      { key: "benefits", label: "Benefits", icon: "🪪", render: () => <BenefitsScreen /> },
      { key: "yield", label: "Yield", icon: "🏧", render: () => <YieldOptScreen /> },
      { key: "deals", label: "Deals", icon: "🏷️", render: () => <DealsScreen /> },
    ],
  },
  {
    title: "Tracking",
    items: [
      { key: "fire", label: "FIRE", icon: "🔥", render: () => <FireScreen /> },
      { key: "holdings", label: "Holdings", icon: "🏦", render: () => <HoldingsScreen /> },
      { key: "hsa", label: "HSA", icon: "🩺", render: () => <HsaScreen /> },
      { key: "cardapps", label: "Card apps", icon: "✉️", render: () => <CardAppsScreen /> },
      { key: "subs", label: "Subs", icon: "🔁", render: () => <SubscriptionsScreen /> },
      { key: "goals", label: "Goals", icon: "🏆", render: () => <GoalsScreen /> },
      { key: "shopping", label: "Shopping", icon: "🛒", render: () => <ShoppingPatternsScreen /> },
      { key: "canonical", label: "Catalog", icon: "📦", render: () => <CanonicalProductsScreen /> },
      { key: "merchants", label: "Merchants", icon: "🏪", render: () => <MerchantsScreen /> },
    ],
  },
  {
    title: "Analytics",
    items: [
      { key: "attribution", label: "Attribution", icon: "🔍", render: () => <AttributionScreen /> },
      { key: "tax", label: "Tax", icon: "🧾", render: () => <TaxScreen /> },
      { key: "trends", label: "Trends", icon: "📊", render: () => <TrendsScreen /> },
      { key: "heat", label: "Heatmap", icon: "🔥", render: () => <HeatmapScreen /> },
      { key: "anomaly", label: "Anomaly", icon: "⚠️", render: () => <AnomalyScreen /> },
    ],
  },
  {
    title: "System",
    items: [
      { key: "receipts", label: "Receipts", icon: "🧾", render: () => <ReceiptsScreen /> },
      { key: "connections", label: "Banks", icon: "🔌", render: () => <ConnectionsScreen /> },
      { key: "alerts", label: "Alerts", icon: "🔔", render: () => <NotificationsScreen /> },
      { key: "txns", label: "Txns", icon: "📋", render: () => <TransactionsScreen /> },
    ],
  },
];

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <TabNavigator tabs={PRIMARY_TABS} moreSections={MORE_SECTIONS} />
      </SafeAreaView>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f4f6f9" },
});
