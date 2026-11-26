import { Link } from "wouter";
import { SeraLogo } from "@/components/SeraPayHeader";
import { widgetGuidePath, widgetNetworks } from "@shared/integration-widget";
import { catalog, flows, type Flow } from "./catalog";
import { useWidgetNetwork } from "./WidgetNetwork";
import "./integrations.css";

export function IntegrationHeader({ flow }: { flow: Flow }) {
  const { network, selectNetwork } = useWidgetNetwork();
  return (
    <header className="si-guide-header">
      <div className="si-guide-bar">
        <Link href="/" aria-label="SeraPay homepage"><SeraLogo /></Link>
        <nav className="si-nav" aria-label="Integration guides">
          {flows.map(name => (
            <Link key={name} href={widgetGuidePath(name, network)} aria-current={flow === name ? "page" : undefined}>
              {catalog[name].title}
            </Link>
          ))}
        </nav>
        <div className="si-network-picker" role="group" aria-label="Guide network">
          {widgetNetworks.map(option => (
            <button key={option} type="button" aria-pressed={option === network} onClick={() => selectNetwork(option)}>
              {option === "sepolia" ? "Sepolia" : "Live"}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
