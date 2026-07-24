import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Table, Title, Text, List, ListItem, Anchor, Divider } from "@mantine/core";

export function ReportMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <Title order={2} size="h3" c="zinc.1" mt="xl" mb="md" fw={600}>
            {children}
          </Title>
        ),
        h2: ({ children }) => (
          <>
            <Divider mt="xl" mb="md" color="zinc.8" />
            <Title order={3} size="h4" c="zinc.2" mb="sm" fw={600}>
              {children}
            </Title>
          </>
        ),
        h3: ({ children }) => (
          <Title order={4} size="h5" c="zinc.3" mt="md" mb="xs" fw={500}>
            {children}
          </Title>
        ),
        p: ({ children }) => (
          <Text size="sm" c="zinc.300" mb="xs" lh={1.6}>
            {children}
          </Text>
        ),
        ul: ({ children }) => (
          <List spacing="xs" size="sm" c="zinc.300" mb="md" withPadding>
            {children}
          </List>
        ),
        ol: ({ children }) => (
          <List type="ordered" spacing="xs" size="sm" c="zinc.300" mb="md" withPadding>
            {children}
          </List>
        ),
        li: ({ children }) => <ListItem>{children}</ListItem>,
        a: ({ href, children }) => (
          <Anchor
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            c="blue.4"
            size="sm"
            style={{ wordBreak: "break-all" }}
          >
            {children}
          </Anchor>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-4 border border-zinc-800 rounded-md">
            <Table striped highlightOnHover withColumnBorders={false} verticalSpacing="sm" horizontalSpacing="md" className="text-sm">
              {children}
            </Table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-zinc-800/50">{children}</thead>,
        th: ({ children }) => <th className="text-zinc-300 font-medium">{children}</th>,
        td: ({ children }) => <td className="text-zinc-400">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}