import Masthead from "@/components/Masthead";

/** TEMPORARY placeholder page — the Integrate stage replaces this. */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-[960px] flex-1 flex-col px-4">
      <Masthead pieceId={null} />
      <div className="flex flex-1 items-center justify-center py-16">
        <p className="font-display text-2xl font-bold uppercase tracking-wide text-mute">
          Pick your peg
        </p>
      </div>
    </main>
  );
}
