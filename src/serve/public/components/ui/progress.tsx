import { Indicator, Root } from '@radix-ui/react-progress';
import type * as React from 'react';

import { cn } from '../../lib/utils';

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof Root>) {
  return (
    <Root
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-primary/20',
        className
      )}
      data-slot="progress"
      {...props}
    >
      <Indicator
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </Root>
  );
}

export { Progress };
