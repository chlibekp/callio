import { useState } from "react";
import { Video, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home({ onCreate }: { onCreate: (id: string) => void }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { id } = await fetch("/api/rooms", { method: "POST" }).then((r) => r.json());
      onCreate(id);
    } finally {
      setBusy(false);
    }
  };

  const join = () => {
    const id = link.trim().split("/r/").pop()?.replace(/[^\w-]/g, "");
    if (id) onCreate(id);
  };

  return (
    <main className="flex h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-secondary">
            <Video />
          </div>
          <CardTitle className="text-xl">Callio</CardTitle>
          <CardDescription>Video, voice, chat and screen sharing. No accounts. Media is relayed through the server, so participants never see each other's IP.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button className="w-full" onClick={create} disabled={busy}>
            New call
          </Button>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> or join <div className="h-px flex-1 bg-border" />
          </div>
          <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), join())}>
            <Input placeholder="Paste link or code" value={link} onChange={(e) => setLink(e.target.value)} />
            <Button type="submit" variant="secondary" size="default" disabled={!link.trim()}>
              <ArrowRight />
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
