import Navigation from "../components/navigation";
import Hero from "../components/hero";
import Features from "../components/features";
import Cta from "../components/cta";

export default function LandingPage() {
  return (
    <div className="bg-black text-white">
      <Navigation />
      <main>
        <Hero />
        <Features />
        <Cta />
      </main>
    </div>
  );
}