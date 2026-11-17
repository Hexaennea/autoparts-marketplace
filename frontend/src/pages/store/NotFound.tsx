import art from "../../assets/art/gasket.svg";
import { Button, Empty } from "../../ui/core";

export function NotFound() {
  return (
    <div className="container page">
      <Empty art={art} title="We couldn't find that page" action={<Button to="/" variant="primary">Back to home</Button>}>
        The link may be old, or the part may no longer be listed. Search by part number to find it again.
      </Empty>
    </div>
  );
}
