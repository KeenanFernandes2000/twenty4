import { Stack } from 'expo-router';
import { Placeholder } from '../../components/Placeholder';

export default function SignIn() {
  return (
    <>
      <Stack.Screen options={{ title: 'Sign in' }} />
      <Placeholder name="Sign in (1.2)" icon="log-in-outline" description="Email / phone OTP, Apple, Google." />
    </>
  );
}
