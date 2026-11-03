# AOP Features

## Projects
Projects are a way of organising different bits of work done with aop into logical groups.

## Graph View (main view)
The main view you'll be in is your per-project graph view. 
This will be where you oversee all the work ta

## Nodes


### Types of Node

#### Scheduled nodes
A scheduled node stays where it is and creates a new child node each time its cron schedule fires. The child carries out the task described on the scheduled node. The default stages don't include one, so add the built-in `scheduled` stage to a type in your `stages.yaml` to use it.