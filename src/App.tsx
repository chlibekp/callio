import { useEffect, useState } from "react";
import Home from "./Home";
import Room from "./Room";

function currentRoom() {
  const m = location.pathname.match(/^\/r\/([\w-]+)$/);
  return m ? m[1] : null;
}

export default function App() {
  const [roomId, setRoomId] = useState(currentRoom);
  useEffect(() => {
    const onPop = () => setRoomId(currentRoom());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (id: string | null) => {
    history.pushState(null, "", id ? `/r/${id}` : "/");
    setRoomId(id);
  };
  return roomId ? <Room key={roomId} roomId={roomId} onLeave={() => go(null)} /> : <Home onCreate={go} />;
}
