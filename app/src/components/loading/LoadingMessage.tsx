import { makeStyles, tokens } from "@fluentui/react-components";

const messages = [
  "Downloading more RAM",
  "Now in Technicolor",
  "Previously on Lidarr...",
  "Bleep Bloop.",
  "Locating the required gigapixels to render...",
  "Spinning up the hamster wheel...",
  "At least you're not on hold",
  "Hum something loud while others stare",
  "Loading humorous message... Please Wait",
  "I could've been faster in Python",
  "Don't forget to rewind your tracks",
  "Congratulations! You are the 1000th visitor.",
  "HELP! I'm being held hostage and forced to write these stupid lines!",
  "RE-calibrating the internet...",
  "I'll be here all week",
  "Don't forget to tip your waitress",
  "Apply directly to the forehead",
  "Loading Battlestation",
];

let message: string | null = null;

const useStyles = makeStyles({
  loadingMessage: {
    color: tokens.colorNeutralForeground2,
    maxWidth: "34ch",
    textAlign: "center",
  },
});

export default function LoadingMessage() {
  const styles = useStyles();

  if (!message) {
    const index = Math.floor(Math.random() * messages.length);
    message = messages[index];
  }

  return <div className={styles.loadingMessage}>{message}</div>;
}
