import { Stack } from 'expo-router';
import { Placeholder } from '../../components/Placeholder';

export default function Contacts() {
  return (
    <>
      <Stack.Screen options={{ title: 'Find friends' }} />
      <Placeholder name="Contacts (1.5)" icon="people-outline" description="Find friends to add." />
    </>
  );
}
