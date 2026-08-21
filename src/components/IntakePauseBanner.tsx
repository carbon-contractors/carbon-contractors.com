import styles from "./IntakePauseBanner.module.css";

export default function IntakePauseBanner() {
  const isPaused =
    process.env.NEXT_PUBLIC_INTAKE_PAUSED === "true" ||
    process.env.NEXT_PUBLIC_INTAKE_PAUSED === "1" ||
    process.env.NEXT_PUBLIC_INTAKE_PAUSED === "yes";

  if (!isPaused) return null;

  const notice =
    process.env.NEXT_PUBLIC_INTAKE_PAUSE_NOTICE ||
    "Task intake is temporarily paused for system maintenance. In-flight tasks and settlements continue normally.";

  return (
    <aside className={styles.banner} role="alert" aria-live="assertive">
      <div className={styles.inner}>
        <div className={styles.left}>
          <span className={styles.badge}>INTAKE PAUSED</span>
          <span className={styles.message}>
            {notice}
            <span className={styles.reassurance}>
              (Claims and active settlements are unaffected)
            </span>
          </span>
        </div>
      </div>
    </aside>
  );
}
