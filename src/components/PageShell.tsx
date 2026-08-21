import CrtGrid from "./CrtGrid";
import NavBar from "./NavBar";
import Footer from "./Footer";
import IntakePauseBanner from "./IntakePauseBanner";
import styles from "./PageShell.module.css";

export default function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <CrtGrid />
      <IntakePauseBanner />
      <NavBar />
      <main className={styles.main}>{children}</main>
      <Footer />
    </div>
  );
}
