import { Detail } from "@raycast/api";
import AuthorizedView from "./components/AuthorizedView";

export default function Command() {
  return (
    <AuthorizedView>
      <Detail markdown="# Hello World" />
    </AuthorizedView>
  );
}
