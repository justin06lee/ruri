import { useState } from "react";
import { getGreetings, greetingsFromText, setGreetings } from "../greetings";
import { Row } from "./SettingsRows";

/**
 * Settings → Greeting: what Home says over its empty chat. The textarea
 * keeps what is typed as typed; what is kept is the lines in it.
 */
export function GreetingEditor() {
  const [text, setText] = useState(() => getGreetings().join("\n"));
  return (
    <Row
      label="Home says"
      info="One line is always said. Put several, one to a line, and they take turns: a new one each launch."
    >
      <div className="greeting-edit">
        <textarea
          // one line, the way a field is — it grows only as lines are added
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          value={text}
          placeholder="nothing — no title on Home"
          onChange={(e) => {
            setText(e.target.value);
            setGreetings(greetingsFromText(e.target.value));
          }}
        />
      </div>
    </Row>
  );
}
