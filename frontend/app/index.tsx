// Entrypoint: redirects to login or tabs. Both are handled by _layout Router.
import { Redirect } from "expo-router";

export default function Index() {
  return <Redirect href="/login" />;
}
