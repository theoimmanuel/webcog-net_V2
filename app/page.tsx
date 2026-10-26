import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <header className="flex flex-col gap-4">
        <p className="text-sm font-medium uppercase tracking-widest text-neutral-400">
          Adaptive interface research
        </p>
        <h1 className="text-4xl font-semibold sm:text-5xl">WebCog-Net</h1>
        <p className="max-w-2xl text-lg text-neutral-300">
          A cognitive-load-aware web interface that declutters itself in
          response to detected workload. Everything — computer vision,
          inference, and adaptive logic — runs entirely in your browser under a
          Privacy-by-Design model.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <Link
          href="/study"
          className="inline-flex w-fit items-center rounded-md bg-neutral-100 px-5 py-3 text-sm font-semibold text-neutral-900 transition hover:bg-white"
        >
          Enter the study
        </Link>
        <p className="text-sm text-neutral-500">
          You will be asked for informed consent before any data collection or
          webcam access.
        </p>
      </section>
    </main>
  );
}
